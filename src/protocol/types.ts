// Wire types for CP-Handshake and CP-Commit v0.1 (see spec/).
import type { PublicJwk } from '../crypto/jws.ts';

export const CP_VERSION = '0.1';
export const API_PREFIX = '/cp/v0.1';

export const SCOPES = {
  create: 'booking:create',
  modify: 'booking:modify',
  cancel: 'booking:cancel',
  waitlist: 'waitlist:join',
} as const;

export type Lang = 'ko' | 'en';

export interface ServiceInfo {
  id: string;
  name: string;
  duration_min: number;
  price: number;
}

export interface StaffInfo {
  id: string;
  name: string;
}

export interface Policies {
  hold_ttl_s: number;
  cancellation: { free_until_h: number; late_fee: number };
  deposit: { amount: number; required: 'none' | 'self-asserted' | 'all' };
}

export interface Hours {
  open: string; // "HH:MM" local
  close: string; // "HH:MM" local
  days: number[]; // 0 = Sunday
}

export interface BusinessCard {
  cp_version: string;
  business_id: string;
  name: string;
  tel: string; // E.164
  locale: string;
  timezone: string; // IANA name, informational
  utc_offset: string; // "+09:00"; v0.1 assumes a fixed offset
  currency: string;
  hours: Hours;
  services: ServiceInfo[];
  staff: StaffInfo[];
  policies: Policies;
  api: string;
  keys: PublicJwk[];
}

export interface Slot {
  slot_id: string;
  service_id: string;
  staff_id: string;
  start: string; // RFC 3339 with offset
  end: string;
}

export interface Hold {
  hold_id: string;
  slot: Slot;
  expires_at: string;
}

export interface Booking {
  booking_id: string;
  status: 'confirmed' | 'cancelled';
  slot: Slot;
  customer: { display_name: string; contact?: string };
  price: number;
  currency: string;
  channel: 'agent' | 'voice' | 'staff';
  agent_id?: string;
  principal?: string;
  created_at: string;
  updated_at: string;
}

/** Payload of a mandate JWS: who the agent acts for and what it may do. */
export interface Mandate {
  typ: 'cp.mandate';
  iss: string; // operator id (or the agent itself when self-asserted)
  sub: string; // pseudonymous principal id
  agent_id: string;
  cnf: { jkt: string }; // thumbprint of the agent key that must present it
  scope: string[];
  max_amount?: { value: number; currency: string };
  iat: number;
  exp: number;
}

/** Payload of a proof-of-possession JWS signed by the agent key. */
export interface Proof {
  typ: 'cp.proof';
  aud: string; // business_id
  session_id?: string;
  iat: number;
}

/** Payload of a registry-signed rendezvous record. */
export interface RendezvousRecord {
  typ: 'cp.rendezvous';
  code: string;
  session_id: string;
  business_id: string;
  tel: string;
  api: string;
  business_jwk: PublicJwk;
  iat: number;
  exp: number;
}

/** Payload of a registry-signed lookup record (discovery without a call). */
export interface LookupRecord {
  typ: 'cp.lookup';
  business_id: string;
  tel: string;
  api: string;
  business_jwk: PublicJwk;
  iat: number;
  exp: number;
}

/** Payload of a business-signed receipt. */
export interface Receipt {
  typ: 'cp.receipt';
  action: 'booked' | 'modified' | 'cancelled';
  booking_id: string;
  business_id: string;
  slot: Slot;
  price: number;
  currency: string;
  fee: number;
  agent_id?: string;
  session_id?: string;
  iat: number;
}

/** Payload of a business-signed offer sent to waitlisted agents. */
export interface Offer {
  typ: 'cp.offer';
  offer_id: string;
  business_id: string;
  slot: Slot;
  expires_at: string;
  iat: number;
}

export interface AgentIdentity {
  agent_id: string;
  operator: string;
  jwk: PublicJwk;
}
