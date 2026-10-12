# Native auto review

Native's **Auto review** level uses Scribe's configured classifier to review every
shell command. It replaces the previous command-prefix allowlist. Configure a
source in Settings → Classifier, leave Native auto review enabled, and permit
Tool calls (and Messages when user-message context is included).

A command runs automatically only with a finite safe probability of at least
0.95, within three seconds. Reviews are not cached. Missing sources, disabled
features/content sending, failures, missing answers, timeouts and uncertain
verdicts fall back to the normal approval prompt with a reason. Encoded commands,
privilege elevation and common download-and-execute forms always require approval.
Commands or user-message context above the review size bounds also require approval;
the classifier never receives a truncated command as grounds for a grant.

Direct workspace edits use the host's existing resolved-path checks. Outside
targets and dependency junctions escaping the workspace ask for approval. Hooks
and prompt-injection gates still run first; explicit human-only requests are never
auto-reviewed. Full access, Ask first and Auto-edit retain their own behavior.
Calls between turns do not receive classifier grants.

This is a screening layer, not an OS sandbox. The classifier sees command text,
workspace and the current user message; it cannot prove the effects of scripts,
binaries or filesystem changes after review. Native process isolation and
script-aware review remain follow-ups (#75, #592).
