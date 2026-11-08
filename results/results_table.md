## Results: BBBD Exp 2, 8 channels, attentive vs distracted (AUC)

| Model | Window | Calibrated (leave-one-video-out) | Calibrated (train on 1 video) | New person (3 folds) | New person + re-centering |
|---|---|---|---|---|---|
| Riemannian (Tang) | 2 s | 0.842 | 0.748 | 0.617 | 0.666 |
| Riemannian (Tang) | 4 s | 0.872 | 0.796 | 0.636 | 0.702 |
| CBraMod frozen + probe | 4 s | 0.684 | — | 0.564 | — |

- Gate 1: GO (calibrated AUC >= 0.70)
- Gate 2: STOP: probe 0.684 vs Riemannian 0.872 (gap -0.188); Riemannian wins
