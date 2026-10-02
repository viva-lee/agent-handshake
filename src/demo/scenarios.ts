// Runs one end-to-end scenario against real local HTTP servers and returns a timeline.
import { CustomerAgent, type CallerKind } from '../agents/customer-agent.ts';
import { Receptionist } from '../agents/receptionist.ts';
import { SimCall, Timeline, type TimelineEvent, type VoiceTiming } from '../agents/sim-call.ts';
import { Business } from '../business/business.ts';
import { generateKeyPair } from '../crypto/jws.ts';
import { listen } from '../net/http.ts';
import { API_PREFIX, type Booking, type Lang } from '../protocol/types.ts';
import { Registry } from '../registry/registry.ts';
import { demoFixture, seedBookings } from './fixtures.ts';

export type ScenarioName = 'handshake' | 'ai-no-cp' | 'human' | 'direct';
export const SCENARIOS: ScenarioName[] = ['handshake', 'ai-no-cp', 'human', 'direct'];

/** Assumptions behind the simulated clock; shown next to every result. */
export const ASSUMED_RTT_MS = 120;
export const VOICE_TIMING: Record<Lang, VoiceTiming> = {
  ko: { msPerChar: 150, turnGapMs: 700 },
  en: { msPerChar: 65, turnGapMs: 700 },
};

export interface ScenarioOptions {
  lang?: Lang;
  dialedOverride?: string; // simulate dialing a different number than the registry record
  cpEnabled?: boolean; // whether the receptionist offers the handshake
}

export interface ScenarioResult {
  scenario: ScenarioName;
  lang: Lang;
  business: { name: string; tel: string };
  principal: string;
  events: TimelineEvent[];
  totals: Record<string, number>;
  outcome: {
    booked: boolean;
    via: 'agent-api' | 'voice' | 'none';
    handshake: 'completed' | 'not-offered' | 'offered-ignored' | 'failed' | 'no-call';
    failure?: string;
    booking?: Pick<Booking, 'booking_id' | 'slot' | 'price' | 'currency' | 'channel'> & { staff: string; service: string };
    receipt_verified?: boolean;
  };
  assumptions: { assumed_rtt_ms: number; ms_per_char: number; turn_gap_ms: number; note: string };
}

const KIND: Record<Exclude<ScenarioName, 'direct'>, CallerKind> = {
  handshake: 'cp-agent',
  'ai-no-cp': 'ai-agent',
  human: 'human',
};

export async function runScenario(name: ScenarioName, opts: ScenarioOptions = {}): Promise<ScenarioResult> {
  const lang = opts.lang ?? 'en';
  const fx = demoFixture(lang);
  const timeline = new Timeline(ASSUMED_RTT_MS);
  const trace = timeline.net.bind(timeline);

  const registry = new Registry({ registryId: '0' });
  const registrySrv = await listen(registry.router());
  const business = new Business(fx.config);
  const businessSrv = await listen(business.router());
  business.api = `${businessSrv.url}${API_PREFIX}`;

  try {
    await business.enroll(registrySrv.url);
    seedBookings(business, fx);
    const operator = { id: 'demo-operator', keys: generateKeyPair() };
    registry.registerOperator(operator.id, operator.keys.publicJwk);

    const caller = new CustomerAgent({
      lang,
      kind: name === 'direct' ? 'cp-agent' : KIND[name],
      principal: fx.principal,
      request: fx.request,
      dialed: opts.dialedOverride ?? fx.config.tel,
      registries: { '0': { url: registrySrv.url, jwk: registry.keys.publicJwk } },
      operator,
      onTrace: trace,
    });

    let receptionist: Receptionist | undefined;
    if (name === 'direct') {
      await caller.bookDirect('0', fx.config.tel);
    } else {
      receptionist = new Receptionist({ business, lang, cpEnabled: opts.cpEnabled ?? true });
      receptionist.onTrace = trace;
      await new SimCall(caller, receptionist, timeline, VOICE_TIMING[lang]).run();
    }

    const booking = caller.result?.booking ?? receptionist?.booking;
    const handshake =
      name === 'direct'
        ? 'no-call'
        : caller.result
          ? 'completed'
          : !receptionist?.offered
            ? 'not-offered'
            : caller.failure
              ? 'failed'
              : 'offered-ignored';
    const staffName = (id: string) => fx.config.staff.find((s) => s.id === id)?.name ?? id;
    const serviceName = (id: string) => fx.config.services.find((s) => s.id === id)?.name ?? id;
    const timing = VOICE_TIMING[lang];

    return {
      scenario: name,
      lang,
      business: { name: fx.config.name, tel: fx.config.tel },
      principal: fx.principal.display_name,
      events: timeline.events,
      totals: timeline.totals(),
      outcome: {
        booked: Boolean(booking),
        via: caller.result ? 'agent-api' : booking ? 'voice' : 'none',
        handshake,
        failure: caller.failure,
        booking: booking && {
          booking_id: booking.booking_id,
          slot: booking.slot,
          price: booking.price,
          currency: booking.currency,
          channel: booking.channel,
          staff: staffName(booking.slot.staff_id),
          service: serviceName(booking.slot.service_id),
        },
        receipt_verified: caller.result?.receipt_verified,
      },
      assumptions: {
        assumed_rtt_ms: ASSUMED_RTT_MS,
        ms_per_char: timing.msPerChar,
        turn_gap_ms: timing.turnGapMs,
        note: 'Simulated clock. Speech time is estimated from text length; HTTP time is measured on localhost plus an assumed round trip.',
      },
    };
  } finally {
    await businessSrv.close();
    await registrySrv.close();
  }
}
