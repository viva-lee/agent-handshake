# CP-Commit v0.1

**Status:** Draft, 2026-10-02. Experimental; not for production use.
**Part of:** [Counter Protocol](README.md). Companion: [CP-Handshake](handshake.md).

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be interpreted as described in RFC 2119 and RFC 8174.

## 1. Purpose

CP-Commit is the API an agent uses to make and change commitments with a business: find out what it offers, see free times, hold one, book it, change or cancel it, get offered a freed slot, or hand off to a person. The same API serves sessions opened by a phone handshake and sessions opened directly over the internet.

v0.1 models appointment businesses (staff × service × time). Tables, rooms and other resources are open issues.

## 2. Transport

- HTTPS with JSON bodies. Base URL `{api}` ends in `/cp/v0.1`.
- Times are RFC 3339 with an explicit offset, in the business's local time (e.g. `2026-10-03T14:00:00+09:00`). v0.1 assumes a fixed UTC offset per business.
- Amounts are numbers in the major unit of the card's `currency` (35000 for ₩35,000; 65 for $65). Minor units are an open issue.
- Errors: an HTTP status plus `{ "error": { "code": "…", "message": "…", "details": … } }`.
- Signed objects are compact JWS with `alg: EdDSA` (Ed25519, RFC 8037) and `kid` = RFC 7638 thumbprint.

## 3. Credentials and sessions

### 3.1 Mandate

A mandate states who the agent acts for and what it may do. It is a JWS with this payload:

```jsonc
{
  "typ": "cp.mandate",
  "iss": "demo-operator",         // operator id
  "sub": "principal_7f3a",        // pseudonymous principal id, stable per business
  "agent_id": "agent_…",
  "cnf": { "jkt": "…" },          // thumbprint of the agent key that must present it
  "scope": ["booking:create", "booking:modify", "booking:cancel", "waitlist:join"],
  "max_amount": { "value": 50000, "currency": "KRW" },   // optional spending cap
  "iat": 1790940000,
  "exp": 1790940600
}
```

- If the mandate is signed by the key the registry lists for `iss` (`GET /operators/{iss}`), the session's trust is `operator-verified`.
- Otherwise the business MAY accept a mandate signed by the agent key itself; trust is then `self-asserted`.
- The business MUST check that `agent_id` matches the presented identity, `cnf.jkt` matches the presented key, and `exp` has not passed.

### 3.2 Proof

A proof is a JWS signed by the agent key: `{ "typ": "cp.proof", "aud": "<business_id>", "session_id": "<when handshaking>", "iat": … }`. The business MUST check `aud`, `session_id` when present, and that `iat` is within ±120 s.

### 3.3 Opening a session

| Path | When | Body | Returns |
| --- | --- | --- | --- |
| `POST /handshake/accept` | during a call ([CP-Handshake §5](handshake.md#5-flow)) | `session_id`, `caller`, `mandate`, `proof` | `session_token`, `bind_code`, `bind_deadline`, `expires_at`, `trust` |
| `POST /sessions` | no call; endpoint found via registry lookup or the card | `caller`, `mandate`, `proof` | `session_token`, `session_id`, `expires_at`, `trust` |

`caller` is `{ "agent_id", "operator", "jwk" }`. Session tokens are bearer tokens (`Authorization: Bearer …`) valid for 15 minutes. Direct sessions are bound immediately; handshake sessions are bound by the BIND step.

## 4. Discovery

`GET /card` (also served at `/.well-known/cp-card.json`) returns the business card without authentication:

| Field | Meaning |
| --- | --- |
| `cp_version`, `business_id`, `name`, `tel`, `locale` | identity |
| `timezone`, `utc_offset`, `hours` | when it is open (`hours.days`: 0 = Sunday) |
| `currency`, `services[]` | `{id, name, duration_min, price}` |
| `staff[]` | `{id, name}` |
| `policies` | `hold_ttl_s`, `cancellation {free_until_h, late_fee}`, `deposit {amount, required: none \| self-asserted \| all}` |
| `api`, `keys[]` | endpoint and the business's public keys (receipts and offers are signed with them) |

## 5. Operations

| Method and path | Session | Scope | Result |
| --- | --- | --- | --- |
| `GET /session` | any | — | `{session_id, bound, trust, agent_id}` |
| `POST /availability` `{service_id, staff_id?, from, to, limit?}` | any (unbound allowed) | — | `{slots: Slot[]}` |
| `POST /holds` `{slot_id}` | bound | `booking:create` | `Hold` (`201`), or `409 slot_unavailable` |
| `DELETE /holds/{id}` | any | — | releases the hold |
| `POST /bookings` `{hold_id, customer:{display_name, contact?}, payment_token?}` | bound | `booking:create` | `{booking, receipt}` (`201`) |
| `GET /bookings/{id}` | any, same principal | — | `{booking}` |
| `POST /bookings/{id}/modify` `{hold_id}` | bound, same principal | `booking:modify` | `{booking, fee, receipt}` |
| `POST /bookings/{id}/cancel` | bound, same principal | `booking:cancel` | `{booking, fee, receipt}` |
| `POST /waitlist` `{service_id, staff_id?, from, to, callback_url}` | bound | `waitlist:join` | `{waitlist_id}` |
| `POST /offers/{id}/claim` | bound, offered | `booking:create` | `Hold`, or `409 offer_taken` |
| `POST /handoff` `{reason?, summary?}` | any | — | `{ticket_id, message}`: a person will follow up |

A `Slot` is `{slot_id, service_id, staff_id, start, end}`. `slot_id` is opaque to agents. Holds expire after `policies.hold_ttl_s` seconds.

## 6. Policies

- **Cancellation and changes.** If the booking starts within `free_until_h` hours, `fee` is `late_fee`; otherwise 0. The fee is reported in the response and the receipt.
- **Deposits.** If `deposit.required` is `all`, or `self-asserted` and the session is self-asserted, a booking without `payment_token` fails with `402 deposit_required` and `details: {amount, currency}`. In v0.1 `payment_token` is opaque. Binding it to scoped payment tokens such as ACP Shared Payment Tokens or AP2 mandates is planned.
- **Spending caps.** If the mandate has `max_amount` and the price exceeds it, or the currency differs, the business MUST refuse with `403 over_mandate_limit`.

## 7. Receipts

Every booking, change and cancellation returns a receipt: a JWS signed by a business key from the card.

```jsonc
{
  "typ": "cp.receipt",
  "action": "booked",          // booked | modified | cancelled
  "booking_id": "bk_…",
  "business_id": "seongsu-hair",
  "slot": { "slot_id": "…", "service_id": "cut-women", "staff_id": "kim", "start": "…", "end": "…" },
  "price": 35000, "currency": "KRW", "fee": 0,
  "agent_id": "agent_…", "session_id": "hs_…",
  "iat": 1790940012
}
```

Agents SHOULD verify the receipt and keep it; it is the principal's proof of what was agreed.

## 8. Offers

When a slot frees up, the business SHOULD offer it to matching waitlist entries by `POST {callback_url}` with `{ "offer": "<JWS cp.offer>" }`. The offer carries `offer_id`, `slot` and `expires_at` (reference: 120 s). The first `POST /offers/{id}/claim` wins and receives a hold; later claims get `409 offer_taken`. Agents MUST verify the offer signature against the card's keys before acting on it.

## 9. Error codes

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `bad_request`, `bad_window`, `bad_slot_id` | malformed input |
| 401 | `unauthorized`, `bad_proof`, `bad_mandate` | missing or invalid session or credentials |
| 402 | `deposit_required` | a deposit must be attached |
| 403 | `not_bound`, `insufficient_scope`, `over_mandate_limit`, `forbidden`, `not_offered` | not allowed |
| 404 | `unknown_session`, `unknown_service`, `unknown_staff`, `unknown_hold`, `unknown_booking`, `unknown_offer` | not found |
| 409 | `session_already_accepted`, `slot_unavailable`, `offer_taken`, `not_confirmed` | conflict |
| 410 | `hold_expired`, `offer_expired` | too late |

## 10. Mapping to MCP and A2A (planned for v0.2)

CP-Commit is meant to sit on top of the general agent protocols, not compete with them.

| CP-Commit | MCP tool (proposed) | A2A |
| --- | --- | --- |
| `GET /card` | `cp_get_card` | skill listed in the Agent Card |
| `POST /availability` | `cp_find_times` | task with structured input |
| `POST /holds` + `POST /bookings` | `cp_book` | task |
| `POST /bookings/{id}/modify` | `cp_reschedule` | task |
| `POST /bookings/{id}/cancel` | `cp_cancel` | task |
| `POST /waitlist` | `cp_join_waitlist` | task with push notification |

## 11. Privacy

Businesses see a pseudonymous principal id, a display name and an optional contact, and nothing else unless the principal agrees. A principal id SHOULD differ per business so that businesses cannot link a person across shops.

## 12. Open issues

- Resources other than staff (tables, rooms), bundles and recurring bookings.
- Time zones with daylight saving time (v0.1 uses a fixed offset).
- Idempotency keys for retries; pagination of availability.
- Payment binding (ACP / AP2) and refunds.
- Moving proofs to HTTP Message Signatures (RFC 9421 / Web Bot Auth) for compatibility with agent-identity work on the web.
