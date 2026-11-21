"""
Train LightGBM conversion model with isotonic calibration.
Time-based split: Jun–Sep train, Oct validate, Nov holdout.
python -m models.train_conversion
"""
from __future__ import annotations

import logging
import pickle
from pathlib import Path

import joblib
import lightgbm as lgb
import numpy as np
import pandas as pd
import shap
from sklearn.calibration import CalibratedClassifierCV
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score, average_precision_score, brier_score_loss
from sklearn.preprocessing import LabelEncoder

from etl.build_snapshots import get_connection
from etl.features import build_features, get_X_y, FEATURE_COLS

log = logging.getLogger(__name__)

ARTIFACTS = Path(__file__).parent / "artifacts"
ARTIFACTS.mkdir(exist_ok=True)

MODEL_PATH     = ARTIFACTS / "lgbm_model.pkl"
CALIBRATOR_PATH = ARTIFACTS / "calibrator.pkl"
SHAP_PATH      = ARTIFACTS / "shap_explainer.pkl"
LR_PATH        = ARTIFACTS / "lr_model.pkl"
FEATURE_PATH   = ARTIFACTS / "feature_names.pkl"


def time_split(feat: pd.DataFrame):
    """Return (train, val, holdout) DataFrames based on Created On month."""
    df = feat[~feat["is_live"].fillna(False)].dropna(subset=["converted"]).copy()
    df["created_on"] = pd.to_datetime(df["created_on"])
    df["ym"] = df["created_on"].dt.to_period("M")

    train    = df[df["created_on"].dt.month.isin([6, 7, 8, 9])]
    val      = df[df["created_on"].dt.month == 10]
    holdout  = df[df["created_on"].dt.month == 11]

    log.info("Split → train %d | val %d | holdout %d", len(train), len(val), len(holdout))
    return train, val, holdout


def train(reload_features: bool = False):
    con = get_connection()
    feat = build_features(con=con, use_cache=not reload_features)

    train_df, val_df, holdout_df = time_split(feat)

    X_train, y_train = get_X_y(train_df, exclude_live=False)
    X_val,   y_val   = get_X_y(val_df,   exclude_live=False)
    X_hold,  y_hold  = get_X_y(holdout_df, exclude_live=False)

    feature_names = X_train.columns.tolist()

    # class weight to handle 3% imbalance
    pos_weight = (y_train == 0).sum() / max((y_train == 1).sum(), 1)
    log.info("class pos_weight = %.1f", pos_weight)

    lgb_params = {
        "objective":        "binary",
        "metric":           ["auc", "binary_logloss"],
        "n_estimators":     500,
        "learning_rate":    0.05,
        "num_leaves":       31,
        "min_child_samples": 10,
        "scale_pos_weight": pos_weight,
        "verbosity":        -1,
        "random_state":     42,
        # monotone constraint on fare_ratio: higher fare → lower P(convert) → -1
        "monotone_constraints_method": "advanced",
    }

    model = lgb.LGBMClassifier(**lgb_params)

    # Build monotone constraints array aligned to feature list
    mono = []
    for f in feature_names:
        if f == "fare_ratio":
            mono.append(-1)   # higher fare → lower conversion
        elif f == "load_factor":
            mono.append(-1)   # higher load → less likely to give good deal
        elif f == "seats_available":
            mono.append(1)    # more seats available → higher chance of accepting
        else:
            mono.append(0)
    lgb_params["monotone_constraints"] = mono

    model.set_params(**{k: v for k, v in lgb_params.items() if k != "monotone_constraints_method"})

    model.fit(
        X_train.fillna(-1), y_train,
        eval_set=[(X_val.fillna(-1), y_val)],
        callbacks=[lgb.early_stopping(50, verbose=False), lgb.log_evaluation(100)],
    )

    # Isotonic calibration on validation set
    val_probs = model.predict_proba(X_val.fillna(-1))[:, 1]
    calibrator = IsotonicRegression(out_of_bounds="clip")
    calibrator.fit(val_probs, y_val)

    # Logistic Regression fallback / sanity check
    lr = LogisticRegression(class_weight="balanced", max_iter=500, random_state=42)
    lr.fit(X_train.fillna(-1), y_train)

    # SHAP explainer
    explainer = shap.TreeExplainer(model)

    # Evaluate on holdout
    if len(holdout_df) > 0 and y_hold.sum() > 0:
        hold_raw   = model.predict_proba(X_hold.fillna(-1))[:, 1]
        hold_cal   = calibrator.transform(hold_raw)
        roc_raw    = roc_auc_score(y_hold, hold_raw)
        pr_raw     = average_precision_score(y_hold, hold_raw)
        brier_cal  = brier_score_loss(y_hold, hold_cal)
        log.info("Holdout → ROC-AUC=%.3f  PR-AUC=%.3f  Brier(cal)=%.4f",
                 roc_raw, pr_raw, brier_cal)

    # Save
    joblib.dump(model,      MODEL_PATH)
    joblib.dump(calibrator, CALIBRATOR_PATH)
    joblib.dump(explainer,  SHAP_PATH)
    joblib.dump(lr,         LR_PATH)
    joblib.dump(feature_names, FEATURE_PATH)
    log.info("Artifacts saved to %s", ARTIFACTS)

    return model, calibrator, explainer


def load_model():
    """Load trained model artifacts; train if missing."""
    if not MODEL_PATH.exists():
        log.warning("Model not found – training now …")
        train()

    model      = joblib.load(MODEL_PATH)
    calibrator = joblib.load(CALIBRATOR_PATH)
    explainer  = joblib.load(SHAP_PATH)
    feature_names = joblib.load(FEATURE_PATH)
    return model, calibrator, explainer, feature_names


def predict_proba(X: pd.DataFrame,
                  model=None, calibrator=None,
                  feature_names=None) -> np.ndarray:
    """Return calibrated probabilities. Loads model if not provided."""
    if model is None:
        model, calibrator, _, feature_names = load_model()

    if feature_names is not None:
        X = X.reindex(columns=feature_names)

    raw   = model.predict_proba(X.fillna(-1))[:, 1]
    cal   = calibrator.transform(raw)
    return cal


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    train()
