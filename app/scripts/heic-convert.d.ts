// Ambient declaration for `heic-convert` (pinned runtime dep, 2.1.0; ships no
// types and no @types package). Silences the pre-existing TS7016 at the import
// in harnesses/runner-common.ts:328 so `make check`'s tsc gate passes -- an
// operator-authorized enabling fix (2026-08-15) for the usage-metrics tasks,
// reversing the decay-round-3 deferral that had parked it in the operator
// scratchpad. Deliberately a bare module declaration: implicit any for an
// untyped runtime dep is the standard trade (the pragmatically-strict note in
// tsconfig.json), and typing the module's surface is not worth inventing here.
declare module "heic-convert";
