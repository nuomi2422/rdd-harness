# Initial licensing audit — 2026-11-22

Scope: published baseline 6b7a91289430e2bf2c99582a73f8a97803d0bc70. This is a limited audit, not a guarantee of ownership or a complete dependency bill of materials.

The published clone is shallow. Its ancestor 813590d has the same Git tree and parent as the full maintenance repository, so that full object history was used to trace origin; in-progress maintenance changes were not treated as published code. The root MIT notice was introduced at c84ea05. Historical CONTRIBUTING explicitly accepted MIT contributions. Author names, including automation aliases, are not proof of legal ownership.

| Candidate file | Published blob | Origin commit | Observed imports | Result |
|---|---|---|---|---|
| bin/exp-judge.js | a2b0ceb425b60bfceb3e5225387e5335ab260aad | 4a9259a16fcf95728e02304c293601700f991443 | Node builtins, local a0-evidence | unchanged MIT candidate, not relicensed |
| bin/lib/a0-evidence.js | 5bd55b0f13e194b7c026e19d0a62dd37e6e603a7 | f59fc8f5b4a85083f77fb0163f5187e7273e46f2 | Node builtins | unchanged MIT candidate, not relicensed |
| bin/lib/nbt.js | 5c52e02dd3374727a039edd7b0b6289dd6cc7ab1 | 6f822be45df37a8d100715b2c2616921bdce7619 | Node fs/zlib | unchanged MIT; includes write capability, not purely read-only |

Full file review found no additional license/attribution headers in those candidates, which does not prove absence of outside derivation. No new program implementation is part of this policy release; merely adding a notice to unchanged MIT material would not reliably achieve the desired protection against closed-source derivatives of the MIT version.

Other categories were not swept into core coverage: external Mineflayer adapters/dependencies; app's dynamic external stager integration; model-adapter examples; graphics; experimental records; world template data; deployment/migration history. No independent new SDK boundary was established. No runtime test or Minecraft operation was performed for this audit.

Outcome: preserve root MIT and all old grants. Introduce explicit future contribution scope, DCO and honest licensing/cost/third-party guidance. Current AGPL-covered code paths remain empty; future contributions require actual provenance and applicable notices before that changes. Do not advertise this policy release as blanket AGPL protection of the existing Harness.
