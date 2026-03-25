# Proposal 013: OP_TRUE Anyone-Can-Spend Outputs

| Field               | Value             |
|---------------------|-------------------|
| Author              | Anders Brownworth |
| Status              | Draft             |
| Created             | 2026-03-25        |
| Category            | Probably Lost     |
| Scale Estimate      | TBD               |

## Problem

Outputs with the script `OP_TRUE` (`0x51`) are technically "anyone can spend" — any node on the
network could claim them by providing an empty scriptSig. In practice, miners or relay nodes
would sweep such outputs immediately if they were large and freshly created.

However, if such an output has remained unspent for more than 3 years, it is reasonable to
conclude that the value is practically inaccessible — either because the output is too small to
justify the fee, or because the original creator intentionally locked funds this way knowing
they would not be claimed.

## Detection

```typescript
if (ctx.script_hex === '51') {
  const threeYearsAgo = new Date();
  threeYearsAgo.setFullYear(threeYearsAgo.getFullYear() - 3);
  if (ctx.block_timestamp < threeYearsAgo) return '013';
}
```

## Classification

Loss bucket: **2** (Probably Lost). Included in "Probably Lost" slider stop.

Note: Fresh OP_TRUE outputs (< 3 years) are classified as loss_bucket=0 until they age into
the threshold. The snapshot updater periodically re-evaluates dormancy.
