# Prior art and related work

Survey as of 2026-10-02. Entries marked *(to verify)* were not checked against a primary source.

| Work | What it does | Relation to CP |
| --- | --- | --- |
| [Model Context Protocol](https://modelcontextprotocol.io) (Agentic AI Foundation since Dec 2025) | Connects models to tools and data. | CP-Commit operations map to MCP tools ([commit.md §10](commit.md#10-mapping-to-mcp-and-a2a-planned-for-v02)). |
| [A2A v1.0](https://a2a-protocol.org/) (joined the Agentic AI Foundation in Aug 2026, [Forbes](https://www.forbes.com/sites/janakirammsv/2026/08/19/agent2agent-joins-the-agentic-ai-foundation-alongside-mcp/)) | Agent-to-agent tasks; Agent Card at `/.well-known/agent-card.json`. | CP can be advertised as an A2A extension; CP adds booking semantics and the phone handshake. |
| [Agent Trust Handshake Protocol (ATH)](https://github.com/ath-protocol/agent-trust-handshake-protocol) | OAuth-based authorization in which both the user and the service must consent before an agent can access a resource. | Similar name, different layer: ATH authorizes agents over HTTP; CP-Handshake is about two agents that meet on a phone call. CP mandates could be issued through such a flow. |
| [GibberLink](https://en.wikipedia.org/wiki/Gibberlink) (2025, open source) | Two voice agents detect each other and switch to data-over-sound (ggwave, about 8–16 bytes/s) inside the call. | CP sends only a short pointer in-band and moves the conversation to HTTPS, with authentication and channel binding. |
| Ribbon Communications patents, e.g. [US10645216B1](https://patents.google.com/patent/US10645216B1/en), [US11588933B2](https://patents.google.com/patent/US11588933B2/en) (priority 2019-03-26, active) | Identify calls originating from AI systems and apply AI-specific handling, including directing AI callers to a web service. | Overlapping problem space. Freedom-to-operate review needed before commercial deployment. |
| SIP AI-indicator headers (P- or X- headers, described in the Ribbon patents) and SIP REFER (RFC 3515) | Out-of-band signaling and call transfer on VoIP legs. | Optional out-of-band carrier for CP; transfers are an open issue. |
| STIR/SHAKEN (RFC 8224, RFC 8588) | Signed caller-ID attestation in telephone networks. | Complements CP's phone-number anchoring; interaction is an open issue. |
| DTMF (ITU-T Q.23/Q.24; RFC 4733 for RTP) | Tone signaling that survives the phone network. | CP's in-band carrier. |
| Web Bot Auth (IETF draft) on HTTP Message Signatures (RFC 9421) *(to verify: draft status)* | Cryptographic identity for bots and agents on HTTP. | CP proofs could move to RFC 9421 signatures. |
| Visa Trusted Agent Protocol *(to verify)* | Merchants verify agents via signed HTTP headers against a directory of agent keys. | Same idea as CP's operator-verified trust, for payments. |
| AP2, Agent Payments Protocol (Google) *(to verify)* | Signed user mandates for agent purchases. | CP mandates play the same role for bookings; alignment planned. |
| Agentic Commerce Protocol (OpenAI and Stripe) and [Stripe Shared Payment Tokens](https://stripe.com/blog/agentic-commerce-suite) *(to verify)* | Scoped payment tokens agents can pass to merchants. | Candidate for CP deposits (`payment_token`). |
| iCalendar / iTIP (RFC 5545, RFC 5546) | Calendar invitations with REQUEST, REPLY, CANCEL and COUNTER. | Fallback format for people without agents in a future person-to-person profile. |
| [Google agentic booking and calling](https://blog.google/products-and-platforms/products/search/search-io-2026/) (I/O 2026) | Google books beauty appointments and calls businesses on users' behalf in the US. | A large source of AI-originated calls that CP-enabled businesses could answer faster. |
| Instinct-to-Instinct protocol (Trusted Person network, Sep 2026) | Closed coordination between Instinct agents. | CP is open and targets agent-to-business, where a closed network does not reach. |
