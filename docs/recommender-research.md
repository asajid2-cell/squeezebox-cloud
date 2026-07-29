# Recommender / Auto-Queue Algorithm — Research Findings

Deep-research report (5 search angles, 24 primary/secondary sources fetched, 25 claims
adversarially verified → 22 confirmed, 3 refuted). This is the **design track**; it is reconciled
against Codex's **ground-truth track** (what Spotty/LMS actually exposes) in the build spec.

> **⚠️ Candidate-generation correction (tandem ground-truth, supersedes the deprecation worry).**
> My initial source-read concluded Spotty radio was dead (its `API.pm` `recommendations`/
> `relatedArtists` call Web-API endpoints deprecated 2024-11-27). **Wrong.** Codex's live JSON-RPC
> query — re-verified by Claude — showed the Spotty **browse menu** still returns a working
> **Artist Radio (200 real, on-taste tracks per seed artist)** + **Related Artists (20)**, via a
> live path distinct from the deprecated raw endpoints. So the **PRIMARY candidate generator is the
> Spotty browse graph** (`search → artist → Artist Radio + Related Artists → their Top Tracks /
> Artist Radio`), seeded from the listener's top artists + the now-playing artist; own
> history/co-listening + global search are fallback. No Spotify token needed. (Artist Radio is
> artist-seeded, not track-seeded.) Full divergence resolution in `TANDEM.md`.

## TL;DR recommended design

A **per-listener contextual bandit that learns online from implicit play/skip feedback**, with
candidate features built from **collaborative co-listening + metadata** (NOT audio features).
Three production-proven pillars:

1. **Online learner — Counterfactual Dueling Bandits (CDB)** is the best fit for our regime (tiny
   user base, one implicit signal per interaction). Treat candidate *models* as arms; model each
   song as a low-dim (d≈22) feature vector `s`; recommend next = `argmax_{s∈S} ⟨w, s⟩`. Per-event
   update is pure vector arithmetic:
   ```
   v   = random_unit_vector(d)      # a "duel" perturbation
   w_c = w + delta * v              # challenger model
   r_c = counterfactual_reward(...) # how the challenger would have ranked the observed song
   w   = w + gamma * r_c * v        # nudge toward the better model
   ```
   Complexity `O(m·d·k)` with d≈22, k≈100 candidates, m≈5 duels — trivially single-process Node.
   — Pereira et al., ACM TORS 2024 (extends RecSys 2019). [4]
   **Alternatives, equally implementable, well-specified:**
   - **LinUCB**: `a_t = argmax_a (xᵀθ̂_a + α·sqrt(xᵀA_a⁻¹x))`, `θ̂_a = A_a⁻¹b_a`; online rank-one
     updates `A_a += xxᵀ`, `b_a += r_t·x`; init `A_a = I_d`. Cost linear in arms, ~O(d²)/trial with
     cached inverse / Sherman-Morrison. — Li et al., WWW 2010. [1]
   - **LinTS** (Bayesian): `B = I_d + Σ b_ab_aᵀ`, `f = Σ b_a r_a`, `μ̂ = B⁻¹f`; sample
     `μ̃ ~ N(μ̂, v²B⁻¹)`, play `argmax_i b_iᵀμ̃`. — Agrawal & Goyal 2013. [2]

2. **Taste profile / candidate features — implicit-feedback collaborative filtering (WRMF/ALS)**.
   Per user-item: binary preference `p_ui = 1[r_ui>0]` and confidence `c_ui = 1 + α·r_ui` (α≈40 in
   the original, tune — one practitioner found ~15 better). Fit
   `min Σ c_ui(p_ui − x_uᵀy_i)² + λ(Σ‖x_u‖² + Σ‖y_i‖²)` by ALS,
   `x_u = (YᵀC^uY + λI)⁻¹ YᵀC^u p(u)`. Linear in non-zeros. Use this to BUILD the candidate feature
   vectors / co-listening similarity that feed the bandit — not as the final ranker.
   — Hu, Koren & Volinsky, ICDM 2008 (10-yr highest-impact award; underlies Spotify-era systems). [5]

3. **Feedback handling** (the part our current shuffle ignores entirely):
   - **Skip-position → label**: skip if interrupted **before 50% of duration**, else play. (50% is a
     defensible default, NOT a universal constant — Deezer <30s, Spotify radio ~5/30s; tune on
     household data.) [4]
   - **Skips are genuine NEGATIVE feedback** (≈ a down-thumb, cosine 0.82 to "down" vs 0.16 to
     "up"), and using them as **hard negatives** in the loss gives ~6% next-song accuracy lift; most
     of the lift is the hard negatives, not the skip-as-input. — SiriusXM UMAP 2024; RecSys 2024. [6][7]
   - **Don't treat every play as an equal positive** — grade by fraction-played via a bounded
     sigmoid `T = β1/(1+exp(−(t−α)/γ)) − β2`; floor out near-zero engagement; saturate so long
     tracks aren't over-rewarded. (Source is news-dwell domain; sound analogy to fraction-played.) [8]
   - **Denoise**: noisy implicit samples show large early-stage loss → down-weight, don't discard.
     — WSDM 2021 Adaptive Denoising. [9]
   - **Replays are NOT monotonic confidence** — satiation: past a point some listeners disengage
     (inverted-U exposure). Cap/decay replay-driven confidence; add recency/repetition penalties.
     This directly tensions the Hu-Koren `c=1+αr` premise — reconcile by capping. — Deezer UMAP 2025. [10]

4. **Explore/exploit, cold-start, anti-filter-bubble** — all one mechanism: the bandit's
   exploration term (LinUCB α-bonus / LinTS posterior sampling / CDB duel perturbation). High
   uncertainty for a new listener → high exploration → fast learning (cold-start). Deliberately
   preserve exploration + repetition penalties to avoid filter-bubble collapse. — Spotify RecSys 2018. [—]

## Refuted (do NOT treat as established)
- LinTS cost is independent of candidate count → **false**; the per-step argmax still scales with
  candidates → **prune candidates** before ranking.
- Spotify's production BaRT "is a bandit" → unverified; bandit framing is well-founded in the
  literature generally, not as a description of BaRT internals.
- "Per-user LinUCB is provably beaten by a shared LinUCB, and CDB beats both for t≥150" → did not
  survive verification. A real **cautionary signal** against naive high-dim per-listener LinUCB on
  tiny feedback, but not proven. → favors **shared-global + per-listener residual**, or starting
  with CDB's low-dim shared `w`.

## Open questions to settle in the spec (reconcile with Codex's ground truth)
1. Optimal skip threshold + grading curve for a *household* (defaults are large-scale/non-music).
2. **Shared household model vs per-listener vs hybrid** (shared global + per-listener residual) —
   the sparse-feedback tiny-user regime argues against fully independent high-dim per-listener.
3. **Listener disambiguation** with no login (who's listening, for per-listener profiles + context).
4. Concrete repetition/recency penalty + exploration schedule that prevents both filter-bubble
   collapse and satiation while staying on-taste.

## Sources (primary unless noted)
[1] Li, Chu, Langford, Schapire — A Contextual-Bandit Approach (LinUCB), WWW 2010 — https://arxiv.org/pdf/1003.0146
[2] Agrawal, Goyal — Thompson Sampling for Contextual Bandits (LinTS), 2013 — https://arxiv.org/pdf/1209.3352
[4] Pereira et al. — Online Learning to Rank for Sequential Music Rec (CDB), ACM TORS 2024 — https://dl.acm.org/doi/10.1145/3625827
[5] Hu, Koren, Volinsky — Collaborative Filtering for Implicit Feedback, ICDM 2008 — http://yifanhu.net/PUB/cf.pdf
[6] Mei, Bembom, Ehmann (SiriusXM) — skip-as-negative, UMAP 2024 — https://arxiv.org/pdf/2406.04488
[7] Seshadri, Shashaani, Knees — contrastive skip-negative, RecSys 2024 — https://arxiv.org/abs/2409.07367
[8] Xie et al. (Tencent/WeChat) — dwell-time debiasing sigmoid, WWW 2023 — https://arxiv.org/pdf/2209.09000
[9] Wang et al. — Denoising Implicit Feedback, WSDM 2021 — https://arxiv.org/pdf/2006.04153
[10] Sguerra et al. (Deezer) — satiation / exposure dynamics, UMAP 2025 — https://arxiv.org/html/2505.02492
[—] McInerney et al. (Spotify) — Explore/Exploit/Explain bandits, RecSys 2018 — https://research.atspotify.com/publications/explore-exploit-explain-personalizing-explainable-recommendations-with-bandits
Spotify Web API migration (audio-features + related-artists deprecated 2024-11-27) — https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide
Spotty plugin source — https://github.com/michaelherger/Spotty-Plugin
