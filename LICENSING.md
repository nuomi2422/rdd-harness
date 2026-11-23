# Licensing scope and contribution policy

Effective for new submissions beginning with this policy revision (2026-11-22). This document is a scope notice, not an additional restriction on previously granted rights. Read the actual license applicable to the files you use. This is engineering guidance, not legal advice or a complete provenance audit.

## Current release: retain historical MIT

The root [LICENSE](LICENSE) remains unchanged. Existing program files in the audited baseline `6b7a91289430e2bf2c99582a73f8a97803d0bc70` retain their MIT grants and required notices. **No existing core file is newly declared AGPL-only by this release.** Old MIT versions remain usable under MIT; adding an AGPL document cannot withdraw those rights. An independently permitted MIT component does not lose its original permissions merely because it is later included in an AGPL-covered combination.

## New core contributions: reciprocal by explicit scope

The approved acceptance policy is **AGPL-3.0-only for rights-cleared new original core implementation or original modifications** in the engineering orchestration/evidence/control areas of `bin/` and `app/`. This is prospective, not a wildcard relicensing of those directories. A contribution must identify the new code, source and relevant rights, preserve earlier notices, carry its applicable SPDX notice, and update [license-scope.json](license-scope.json) with exact paths and version/change boundaries before maintainers claim AGPL coverage. A mixed file must explain the retained MIT portions versus new AGPL material; do not replace its header with an unqualified AGPL-only claim. If provenance or scope cannot be established, do not merge it as rights-cleared AGPL code.

The standard [AGPL v3 text](LICENSES/AGPL-3.0-only.txt) is included for that policy; inclusion is **not evidence that the historical code has been relicensed**. The current AGPL-covered code-path list is empty. No empty SDK, placeholder core or invented code change is introduced merely to claim stronger protection.

A genuinely standalone future SDK may use Apache-2.0, and a lightweight independently licensed example may use MIT, only after its actual boundary and provenance are established. No existing independent SDK has been established by this audit. Communicating over an API, separate process or container does not by itself settle derivative-work/combination questions.

## Exclusions and third-party boundaries

- World templates, saves, experimental outputs, screenshots/media, assets and historical records are not blanket AGPL core code. This policy does not certify their distribution rights. In particular `templates/world/level.dat` is a world-data file with unaudited provenance, not new core implementation.
- Mineflayer-related tools load external packages; those dependencies retain their licenses. Code imported from another project needs source, compatibility and notice review. The lack of a NOTICE file is not proof that all content is original.
- Upstream Numen code, public APIs, names and artwork are governed by their own licenses; this repository's policy cannot relicense them. The Numen asset license restricts use in modified distributions unless separately authorized. Do not publish a modified game binary with those assets based only on the code license.
- Artwork and names are not automatically covered by the new-core policy. Honest compatibility/fork attribution is permitted by this project policy only to the extent applicable rights permit it; no official endorsement or trademark registration is claimed.

## Commercial use, source availability and cost

AGPL allows commercial use and charging. Its remote-interaction requirement concerns the corresponding source for qualifying modified network-interactive versions; distribution has additional obligations. It does not require unrelated independent software to be published solely because it uses a network, nor does it prohibit compliant paid hosting. Do not call the project “noncommercial AGPL.”

The project distributes its own open-source code without a software license fee. It does not promise to fund unlimited model tokens, compute, Minecraft accounts, hosting or third-party APIs. Users may supply compatible models and infrastructure. This policy does not establish a token pool, contribution credits or payment scheme.

## Contributions and review

New submissions follow [CONTRIBUTING](CONTRIBUTING.md) and the unmodified [DCO 1.1](DCO). DCO is a rights certification, not assignment of copyright or a hidden CLA. It cannot retroactively sign old contributions. The submitter must have rights to the license of the specific new material; signing DCO alone does not cure an incompatible source.

This revision changes contribution documentation and future acceptance policy only; no mandatory CI, branch protection, runtime logic, dependencies or game behavior is changed. The audit is recorded in [PROVENANCE-AUDIT](PROVENANCE-AUDIT.md).

References: [GNU AGPL](https://www.gnu.org/licenses/agpl-3.0.html), [FSF on selling free software](https://www.gnu.org/philosophy/selling.html), [DCO](https://developercertificate.org/), [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0).
