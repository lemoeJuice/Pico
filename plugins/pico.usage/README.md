# Usage statistics

This package exposes the Usage page and Runtime plugin. Main Model Step usage is sourced from committed Canonical assistant records; auxiliary model calls and their provider attempts come from Runtime model-call telemetry. The package does not estimate a cost without an effective-dated rate supplied by the operator.

Rate values are currency units per one million tokens. Configure rates by provider and model. Cached input and cache-write rates are optional, but a reported token dimension without a configured rate leaves that call's estimated cost unknown.
