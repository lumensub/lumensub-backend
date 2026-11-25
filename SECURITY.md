# Security policy

LumenSub handles payment flows, so we take reports seriously and would rather
hear about a possible problem early than read about it later.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private reporting instead:
**Security → Report a vulnerability** on this repository. Include what you found,
how to reproduce it and what you think the impact is. A proof of concept against
a local setup or testnet is ideal; please do not test against other people's
deployments or mainnet funds.

We aim to acknowledge reports within three working days and to agree on a fix
and disclosure date with you after that.

## What is in scope

- Anything that lets one merchant read or change another merchant's data.
- Ways to make the keeper charge a subscription that is not due, or to drain the
  keeper account.
- Webhook signing weaknesses, or ways around the private-address check.
- API key handling, authentication bypasses, injection.
- Indexer behaviour that would show a subscription as paid when it was not.

Issues in the smart contract itself belong in
[lumensub-contracts](https://github.com/lumensub/lumensub-contracts/security).

## Supported versions

The project is pre-1.0. Only the latest commit on `main` gets fixes.
