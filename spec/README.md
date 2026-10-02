# Counter Protocol (CP) v0.1

**Status:** Draft, 2026-10-02. Experimental. The name is a working name and may change if the specification moves to a neutral body.

Counter Protocol lets an AI agent and a business's AI finish real-world tasks (bookings first) reliably, whether they meet on a phone call or over the internet.

| Part | What it does |
| --- | --- |
| [CP-Handshake](handshake.md) | Two AIs on a phone call recognize each other with a short DTMF frame, authenticate over HTTPS, bind the session to the call, and stop talking in synthesized speech. |
| [CP-Commit](commit.md) | The business API: card, availability, holds, bookings, changes, cancellations, waitlist offers, handoff. Signed receipts for every change. |
| [Prior art](prior-art.md) | Related protocols, patents and products, and how CP relates to each. |

## Design principles

1. **Works when the other side does not.** Every step falls back to voice. A business with CP still serves people and old agents; an agent with CP still calls businesses without it.
2. **Above MCP and A2A, not beside them.** CP defines what an agent and a business say about commitments. MCP and A2A carry it.
3. **Small enough to implement in a day.** Three tone frames, a handful of JSON endpoints, Ed25519 JWS.
4. **The phone number is the anchor.** A registry vouches that a phone number belongs to an endpoint; the caller checks the number it actually dialed.
5. **Least data.** Pseudonymous principals, no personal data in tones, no caller identity sent to the registry.

## Reference implementation

The repository root contains a dependency-free TypeScript implementation of the registry, a business endpoint, a caller agent, a receptionist and a simulated phone line. See the [top-level README](../README.md).
