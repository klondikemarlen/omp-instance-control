# External Client

Own instance selection, explicit profile/config-root scope, request dispatch, and truthful per-instance outcome reporting. Another OMP instance should use the same client behavior rather than a second broadcast implementation.

Transport and discovery are platform-owned; do not embed Linux socket paths here. Requests select a snapshot of instances, not future replacements.

No executable or command-line contract exists yet. See [shared concepts](../CONCEPTS.md).
