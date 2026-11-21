# Contributing to RDD Harness

## Where contributions belong

This repository contains external engineering tools, not the Minecraft game fork. Send game changes to [minecraft-numen/main](https://github.com/nuomi2422/minecraft-numen/tree/main), public documentation changes through the reviewed documentation publication process, and project-navigation corrections to [the project front door](https://github.com/nuomi2422/restart-developmental-doer/tree/master). Check the current README and actual tool registry rather than historical gate counts or archived workflows.

## DCO 1.1 for new contributions

Starting with this policy revision, new contributions must carry a Developer Certificate of Origin 1.1 sign-off. Read the unmodified [DCO](DCO) before using `git commit -s`. Use a name and email you control and are willing to publish: the sign-off and contribution history are public and may be retained indefinitely. A sign-off certifies submission rights; it does **not** transfer copyright or grant maintainers arbitrary relicensing rights. Do not forge another person's sign-off or retrospectively sign their old commits.

AI-assisted contributions are welcome only after human review of provenance, licensing, dependencies, security and correctness. A model cannot sign for a human. Preserve original copyright and license notices, identify copied/adapted material and its source, and do not submit secrets, personal conversations, private evidence or unreviewed generated assets.

## Contribution review

- One coherent change per PR: state purpose, affected paths, source/derivation, applicable license, tests and known limitations.
- Describe a reproducible failure or intended behavior, then positive and negative checks. Tools returning success and offline tests do not establish deployment or world effects.
- Use applicable existing checks; do not restore archived time locks or unrelated approval gates just because an old document listed them.
- Changes to an acceptance rule must explain the old rule's defect and resulting coverage. Preserve honest failures and unknowns.
- Provide dependency licenses and provenance for imported code. New standalone SDKs require an explicit boundary; do not relabel copied core implementation as a permissive API.

## License boundary

Contribute under the license actually applying to the touched files, as described by LICENSE and any path-specific notice. Historical MIT grants remain valid; a new DCO sign-off does not withdraw them. The approved direction is reciprocal licensing for rights-cleared core releases, not a blanket claim that all files are AGPL. Check the accompanying licensing scope document before asserting a new file's license.

This change introduces a documented submission requirement, not a new mandatory CI gate or branch-protection rule. Existing history is not rewritten. CLA or copyright assignment is not required by this policy.
