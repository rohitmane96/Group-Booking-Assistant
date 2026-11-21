"""
Retrain LightGBM conversion model with:
1. Synthetic data augmentation (Gaussian perturbation of converted examples)
2. Optuna hyperparameter tuning
3. Platt-scaling calibration on combined val set

Run: python -m models.retrain_with_synthetic
"""
from __future__ import annotations
import logging, pickle
import numpy as np
import pandas as pd
import joblib
import optuna
import shap
import lightgbm as lgb
from pathlib import Path
from sklearn.linear_model import LogisticRegression
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import roc_auc_score, average_precision_score, brier_score_loss

optuna.logging.set_verbosity(optuna.logging.WARNING)
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

ARTIFACTS = Path(__file__).parent / "artifacts"
FEATURES = [
    'group_size','num_options','fare_ratio','load_factor','seats_available',
    'low_bc_seats_avail','lead_time','dow_travel','month_travel','created_month',
    'agent_prior_requests','agent_conv_rate','route_prior_requests','route_conv_rate',
    'trip_type_enc'
]
# Key features that discriminate conversions (others mostly null in converted rows)
SIGNAL_FEATURES = ['fare_ratio','lead_time','agent_conv_rate','route_conv_rate','group_size',
                   'num_options','agent_prior_requests','route_prior_requests','dow_travel',
                   'month_travel','created_month']
SYNTH_MULTIPLIER = 8   # generate 8x converted examples as synthetic


def load_data() -> pd.DataFrame:
    feat = pd.read_parquet(Path(__file__).parent.parent / "data/cache/features.parquet")
    feat['trip_type_enc'] = feat['trip_type'].map({'OW':0,'RT':1,'MC':2}).fillna(0).astype(int)
    df = feat[~feat['is_live'].fillna(False)].dropna(subset=['converted']).copy()
    df['created_on'] = pd.to_datetime(df['created_on'])
    return df


def generate_synthetic(conv_df: pd.DataFrame, n_synth: int, rng: np.random.Generator) -> pd.DataFrame:
    """
    Generate synthetic converted examples by perturbing real converted requests.
    Strategy:
      - Sample with replacement from converted rows
      - Add Gaussian noise (5-15% std) to continuous features
      - Clip to realistic bounds
      - Flip converted=1
    """
    base = conv_df[FEATURES + ['converted']].copy()
    n_base = len(base)
    
    rows = []
    while len(rows) < n_synth:
        # Sample a real converted row
        idx = rng.integers(0, n_base)
        row = base.iloc[idx].copy()
        
        # Perturb continuous signal features with Gaussian noise
        noise_pcts = {
            'fare_ratio': 0.08,         # ±8%
            'lead_time': 0.15,          # ±15%
            'agent_conv_rate': 0.10,    # ±10%
            'route_conv_rate': 0.15,    # ±15%
            'group_size': 0.10,         # ±10%
            'agent_prior_requests': 0.10,
            'route_prior_requests': 0.15,
        }
        for feat, std_pct in noise_pcts.items():
            val = row[feat]
            if pd.notna(val) and val > 0:
                noise = rng.normal(0, abs(val) * std_pct)
                row[feat] = val + noise
        
        # Realistic clipping
        if pd.notna(row['fare_ratio']):
            row['fare_ratio'] = np.clip(row['fare_ratio'], 0.50, 1.50)
        if pd.notna(row['lead_time']):
            row['lead_time'] = max(1, round(row['lead_time']))
        if pd.notna(row['group_size']):
            row['group_size'] = max(5, round(row['group_size']))
        if pd.notna(row['agent_conv_rate']):
            row['agent_conv_rate'] = np.clip(row['agent_conv_rate'], 0, 0.15)
        if pd.notna(row['route_conv_rate']):
            row['route_conv_rate'] = np.clip(row['route_conv_rate'], 0, 0.5)
        
        # Randomly vary categorical features
        row['dow_travel'] = rng.integers(0, 7)
        row['month_travel'] = rng.integers(1, 13)
        
        rows.append(row)
    
    return pd.DataFrame(rows, columns=FEATURES + ['converted'])


def time_split(df: pd.DataFrame):
    train = df[df['created_on'].dt.month.isin([6,7,8,9])]
    val   = df[df['created_on'].dt.month == 10]
    hold  = df[df['created_on'].dt.month == 11]
    log.info("Split: train=%d val=%d hold=%d", len(train), len(val), len(hold))
    return train, val, hold


def get_X_y(df: pd.DataFrame):
    X = df[FEATURES].copy()
    y = df['converted'].astype(int)
    return X, y


def retrain():
    rng = np.random.default_rng(42)
    df = load_data()
    train_df, val_df, hold_df = time_split(df)
    
    # --- Synthetic augmentation on train set only ---
    conv_train = train_df[train_df['converted'] == 1]
    n_real_pos = len(conv_train)
    n_synth = n_real_pos * SYNTH_MULTIPLIER
    log.info("Real positives in train: %d | Generating %d synthetic...", n_real_pos, n_synth)
    
    synth_df = generate_synthetic(conv_train, n_synth, rng)
    train_aug = pd.concat([train_df, synth_df], ignore_index=True)
    
    log.info("Augmented train: %d total, %d positives (%.1f%%)",
             len(train_aug), train_aug['converted'].sum(), train_aug['converted'].mean()*100)
    
    X_train, y_train = get_X_y(train_aug)
    X_val,   y_val   = get_X_y(val_df)
    X_hold,  y_hold  = get_X_y(hold_df)
    
    # --- Optuna hyperparameter tuning ---
    def objective(trial):
        params = {
            'objective': 'binary',
            'metric': 'auc',
            'verbosity': -1,
            'random_state': 42,
            'n_estimators': trial.suggest_int('n_estimators', 200, 800),
            'learning_rate': trial.suggest_float('learning_rate', 0.01, 0.15, log=True),
            'num_leaves': trial.suggest_int('num_leaves', 15, 63),
            'min_child_samples': trial.suggest_int('min_child_samples', 5, 30),
            'subsample': trial.suggest_float('subsample', 0.6, 1.0),
            'colsample_bytree': trial.suggest_float('colsample_bytree', 0.6, 1.0),
            'reg_alpha': trial.suggest_float('reg_alpha', 0.0, 1.0),
            'reg_lambda': trial.suggest_float('reg_lambda', 0.0, 1.0),
            # No scale_pos_weight since synthetic augmentation already balances
            'scale_pos_weight': 1,
        }
        m = lgb.LGBMClassifier(**params)
        m.fit(X_train.fillna(-1), y_train,
              eval_set=[(X_val.fillna(-1), y_val)],
              callbacks=[lgb.early_stopping(30, verbose=False), lgb.log_evaluation(-1)])
        val_raw = m.predict_proba(X_val.fillna(-1))[:,1]
        return roc_auc_score(y_val, val_raw)
    
    log.info("Running Optuna (30 trials)...")
    study = optuna.create_study(direction='maximize')
    study.optimize(objective, n_trials=30, show_progress_bar=False)
    
    best = study.best_params
    log.info("Best params: %s", best)
    log.info("Best val AUC: %.4f", study.best_value)
    
    # Retrain with best params on train (no early stopping, use best n_estimators)
    # Monotone constraints: fare_ratio decreases conversion, seats_available increases it
    _mono_map = {'fare_ratio': -1, 'load_factor': -1, 'seats_available': 1}
    mono = [_mono_map.get(f, 0) for f in FEATURES]
    best_params = {
        'objective': 'binary',
        'metric': ['auc', 'binary_logloss'],
        'verbosity': -1,
        'random_state': 42,
        'scale_pos_weight': 1,
        'monotone_constraints': mono,
        'monotone_constraints_method': 'advanced',
        **best,
    }
    model = lgb.LGBMClassifier(**best_params)
    model.fit(
        X_train.fillna(-1), y_train,
        eval_set=[(X_val.fillna(-1), y_val)],
        callbacks=[lgb.early_stopping(50, verbose=False), lgb.log_evaluation(100)],
    )
    
    # --- Calibration on val+hold (not augmented data) ---
    # Use train+val real data for calibration to get more positive examples
    cal_real = pd.concat([train_df, val_df], ignore_index=True)
    X_cal, y_cal = get_X_y(cal_real)
    cal_raw = model.predict_proba(X_cal.fillna(-1))[:,1]
    
    calibrator = IsotonicRegression(out_of_bounds='clip')
    calibrator.fit(cal_raw, y_cal)
    
    # Evaluate on holdout
    hold_raw = model.predict_proba(X_hold.fillna(-1))[:,1]
    hold_cal = calibrator.transform(hold_raw)
    roc = roc_auc_score(y_hold, hold_raw)
    pr  = average_precision_score(y_hold, hold_raw)
    brier = brier_score_loss(y_hold, hold_cal)
    log.info("Holdout ROC-AUC=%.4f  PR-AUC=%.4f  Brier(cal)=%.4f", roc, pr, brier)
    log.info("Holdout cal range: min=%.4f max=%.4f", hold_cal.min(), hold_cal.max())
    
    # Check open requests
    feat_all = pd.read_parquet(Path(__file__).parent.parent / "data/cache/features.parquet")
    feat_all['trip_type_enc'] = feat_all['trip_type'].map({'OW':0,'RT':1,'MC':2}).fillna(0).astype(int)
    open_df = feat_all[feat_all['status'].isin(['Quoted','Submitted'])].copy()
    X_open = open_df[FEATURES].fillna(-1)
    open_raw = model.predict_proba(X_open)[:,1]
    open_cal = calibrator.transform(open_raw)
    log.info("Open requests cal: min=%.4f max=%.4f mean=%.4f", open_cal.min(), open_cal.max(), open_cal.mean())
    
    # --- SHAP explainer ---
    explainer = shap.TreeExplainer(model)
    
    # --- Save artifacts ---
    joblib.dump(model,      ARTIFACTS / "lgbm_model.pkl")
    joblib.dump(calibrator, ARTIFACTS / "calibrator.pkl")
    joblib.dump(explainer,  ARTIFACTS / "shap_explainer.pkl")
    with open(ARTIFACTS / "feature_names.pkl", "wb") as f:
        pickle.dump(FEATURES, f)
    
    log.info("All artifacts saved to %s", ARTIFACTS)
    return model, calibrator


if __name__ == "__main__":
    retrain()
