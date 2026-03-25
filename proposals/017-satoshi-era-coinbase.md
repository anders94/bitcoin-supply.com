# Proposal 017: Satoshi-Era Coinbase Outputs

| Field               | Value             |
|---------------------|-------------------|
| Author              | Anders Brownworth |
| Status              | Draft             |
| Created             | 2026-03-25        |
| Category            | Probably Lost     |
| Scale Estimate      | ~1.1M BTC         |

## Overview

Between blocks 1 and approximately 54,316, a pattern of mining activity known as the
"Patoshi pattern" is visible in the blockchain. These blocks are believed to have been
mined by Satoshi Nakamoto based on analysis of the nonce patterns in coinbase transactions.

None of the associated P2PK coinbase outputs have been moved since approximately 2010.

## Evidence

The Patoshi pattern was identified by Sergio Demian Lerner in 2013. Key observations:
- Distinctive ExtraNonce increment pattern in coinbase scriptsig
- Approximately 1.8M BTC mined in this pattern
- No coins have moved since Satoshi's last known activity (~2010)

## Status

This proposal does **not** create a separate loss rule in the ETL. Instead:
1. Satoshi-era blocks are already covered by the **dormancy slider** (≥14 years dormant)
2. P2PK outputs in these blocks are tagged with Proposal **015** (quantum vulnerable)

A future version could add a dedicated `017` tag with a configurable threshold for
"likely Satoshi pattern" blocks to allow separate toggling on the slider.

## Scale

Approximately 1.1M BTC in Patoshi-pattern blocks that have never moved.
This represents roughly 5.5% of the theoretical maximum supply.

## Caution

The Patoshi attribution is probabilistic, not deterministic. Including these coins as
"probably lost" requires accepting that the pattern analysis is correct. The dormancy
slider subsumes this category at the 14-year mark.
