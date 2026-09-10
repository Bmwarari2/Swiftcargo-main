import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the outbound sender + SSE + settings so the suite is fully offline.
vi.mock('../../utils/waSend.js', () => ({
  sendToContact: vi.fn(async () => ({ ok: true, id: 'msg-1' })),
}));
vi.mock('../../routes/events.js', () => ({
  pushToStaff: vi.fn(),
  pushToUser: vi.fn(),
  pushToAdmins: vi.fn(),
}));
vi.mock('../../utils/waStaffAlert.js', () => ({
  notifyStaff: vi.fn(async () => {}),
}));
vi.mock('../../utils/waSettings.js', () => ({
  getWaSettings: vi.fn(async () => ({
    markup_pct: 10, promo_active: false, promo_type: 'waive_fee',
    promo_message: '', default_delivery_fee_kes: 300,
    welcome_media_urls: [], template_map: {},
  })),
}));

import { handleInbound, isUnqualifiedConfirm, claimsPaid, looksLikeDestination, asksHowToPay,
  saysDeliveryMethod, wantsHuman } from '../../utils/waStateMachine.js';
import { sendToContact } from '../../utils/waSend.js';
import { pushToStaff } from '../../routes/events.js';
import { getWaSettings } from '../../utils/waSettings.js';
import { notifyStaff } from '../../utils/waStaffAlert.js';
import { flattenForFreeText } from '../../utils/sentdm.js';

function makeDb(queryImpl) {
  return { query: vi.fn(queryImpl ?? (async () => ({ rows: [], rowCount: 0 }))) };
}

function contact(overrides = {}) {
  return {
    id: 'c1', phone: '254712345678', state: 'active',
    customer_code: 'TC-1042', full_name: 'Jane Doe',
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('onboarding', () => {
  it('new contact gets the welcome message and moves to awaiting_name', async () => {
    const db = makeDb();
    await handleInbound(db, contact({ state: 'new', customer_code: null, full_name: null }), { id: 'm', body: 'Hi' });
    // state update
    const stateUpdate = db.query.mock.calls.find(([sql]) => sql.includes('UPDATE wa_contacts'));
    expect(stateUpdate[1]).toContain('awaiting_name');
    // The welcome leads with what we do and what it costs, and closes on
    // an invitation — not on a request for their name. The state says a
    // name is still outstanding; the message does not open with it.
    expect(sendToContact).toHaveBeenCalled();
    const welcome = sendToContact.mock.calls[0][2].text;
    expect(welcome).toMatch(/product link/i);
    expect(welcome).not.toMatch(/full name/i);
  });

  it('sends configured welcome media after the welcome text', async () => {
    // handleInbound reads settings at dispatch time AND inside the
    // welcome branch — cover both reads.
    const settings = {
      welcome_media_urls: ['https://cdn.example.com/how-it-works.png'],
      template_map: {},
    };
    getWaSettings.mockResolvedValueOnce(settings).mockResolvedValueOnce(settings);
    const db = makeDb();
    await handleInbound(db, contact({ state: 'new' }), { id: 'm', body: 'Hi' });
    const mediaSend = sendToContact.mock.calls.find(([, , o]) => o.mediaUrl);
    expect(mediaSend[2].mediaUrl).toBe('https://cdn.example.com/how-it-works.png');
  });

  it('re-prompts when the "name" is a link or too short', async () => {
    const db = makeDb();
    await handleInbound(db, contact({ state: 'awaiting_name' }), { id: 'm', body: 'https://amazon.com/dp/x' });
    expect(db.query).not.toHaveBeenCalled(); // no state change
    expect(sendToContact.mock.calls[0][2].text).toMatch(/full name/i);
  });

  it('stores the name and asks for the address', async () => {
    const db = makeDb();
    await handleInbound(db, contact({ state: 'awaiting_name' }), { id: 'm', body: 'John Kamau' });
    const update = db.query.mock.calls[0];
    expect(update[0]).toContain('full_name');
    expect(update[1]).toContain('John Kamau');
    expect(sendToContact.mock.calls[0][2].text).toMatch(/address/i);
  });

  // Eunice said "Hi" while we were waiting on her name and got back
  // "Thanks Hi! What's your delivery address?" — the greeting was stored
  // as her name and the profile moved on without it.
  it.each(['Hi', 'hello', 'Habari', 'Niaje', 'Good morning', 'asante', 'ok', '0700092005'])(
    'does not accept %j as a full name', async (greeting) => {
      const db = makeDb();
      await handleInbound(db, contact({ state: 'awaiting_name' }), { id: 'm', body: greeting });
      expect(db.query).not.toHaveBeenCalled();
      expect(sendToContact.mock.calls[0][2].text).toMatch(/full name/i);
    });

  it('still accepts a one-word name', async () => {
    const db = makeDb();
    await handleInbound(db, contact({ state: 'awaiting_name' }), { id: 'm', body: 'Eunice' });
    expect(db.query.mock.calls[0][1]).toContain('Eunice');
  });

  it('stores the address, which now completes the signup', async () => {
    const db = makeDb(async (sql) => {
      if (sql.includes('nextval')) return { rows: [{ n: '1042' }] };
      return { rows: [], rowCount: 1 };
    });
    await handleInbound(db, contact({ state: 'awaiting_address' }), { id: 'm', body: 'Greenspan Estate, Donholm, Nairobi' });
    const update = db.query.mock.calls.find(([sql]) => sql.includes('UPDATE wa_contacts'));
    expect(update[0]).toContain('delivery_address');
    // The address is the last question now — it completes the signup.
    expect(update[1]).toContain('TC-1042');
    expect(sendToContact.mock.calls[0][2].text).toContain('TC-1042');
  });

  it('never asks for an M-Pesa number', async () => {
    // Payments are identified from the M-Pesa statement, so asking for the
    // number up front only cost us customers at the door.
    const db = makeDb(async (sql) => {
      if (sql.includes('nextval')) return { rows: [{ n: '1044' }] };
      return { rows: [], rowCount: 1 };
    });
    await handleInbound(db, contact({ state: 'new' }), { id: 'm', body: 'Hi' });
    await handleInbound(db, contact({ state: 'awaiting_name' }), { id: 'm', body: 'John Kamau' });
    await handleInbound(db, contact({ state: 'awaiting_address' }), { id: 'm', body: 'Donholm, Nairobi' });
    const said = sendToContact.mock.calls.map(([, , o]) => o.text || '').join(' ');
    expect(said).not.toMatch(/m-?pesa number/i);
    expect(db.query.mock.calls.some(([sql]) => sql.includes('mpesa_number'))).toBe(false);
  });

  it('leads with what we do and invites a link, rather than opening with questions', async () => {
    const db = makeDb();
    await handleInbound(db, contact({ state: 'new' }), { id: 'm', body: 'Hi' });
    const welcome = sendToContact.mock.calls[0][2].text;
    expect(welcome).toMatch(/product link/i);
    expect(welcome).not.toMatch(/what.s your full name/i);
  });
});

describe('tracking auto-reply', () => {
  it('replies with the order status for a known TRK code (any formatting)', async () => {
    const db = makeDb(async (sql) => {
      if (sql.includes('tracking_code')) {
        return { rows: [{
          id: 'o1', contact_id: 'c1', status: 'in_kenya', tracking_code: 'TRK-8821',
          paid_at: '2026-08-01', purchased_at: '2026-08-02', arrived_at: '2026-08-10',
          dispatched_at: null, delivered_at: null,
          delivery_fee_waived: false, delivery_fee_kes: null, customer_code: 'TC-1042',
        }] };
      }
      return { rows: [] };
    });
    await handleInbound(db, contact(), { id: 'm', body: 'status for trk 8821?' });
    const reply = sendToContact.mock.calls[0][2].text;
    expect(reply).toContain('TRK-8821');
    expect(reply).toMatch(/arrived in Kenya/i);
  });

  it('replies not-found for an unknown code', async () => {
    const db = makeDb(async () => ({ rows: [] }));
    await handleInbound(db, contact(), { id: 'm', body: 'TRK-999999' });
    expect(sendToContact.mock.calls[0][2].text).toMatch(/couldn't find/i);
  });

  // The reply used to be a bare list of dates. It's now a labelled block
  // with a progress bar and a what-happens-next line, and it has to stay
  // legible after sent.dm flattens newlines into " · " separators.
  function trackedOrder(over = {}) {
    return {
      id: 'o1', contact_id: 'c1', status: 'dispatched', tracking_code: 'TRK-8821', quote_kes: '17094',
      paid_at: '2026-08-01', purchased_at: '2026-08-02', arrived_at: '2026-08-10',
      dispatched_at: '2026-08-12', delivered_at: null,
      delivery_fee_waived: false, delivery_fee_kes: null, delivery_fee_paid_at: null,
      customer_code: 'TC-1042', ...over,
    };
  }
  const trackDb = (over) => makeDb(async (sql) =>
    (sql.includes('tracking_code') ? { rows: [trackedOrder(over)] } : { rows: [] }));

  it("answers with the parcel's current state, in plain words", async () => {
    await handleInbound(trackDb(), contact(), { id: 'm', body: 'TRK-8821' });
    const reply = sendToContact.mock.calls[0][2].text;
    expect(reply).toBe(
      'TRK-8821 — your parcel went out for delivery on 12 August. '
      + 'Our rider will call you when they arrive, usually within 24 hours.'
    );
    // Everything the earlier version padded it out with is gone.
    expect(reply).not.toMatch(/Progress:|Status:|Next:|KSh/);
  });

  it('words each stage for itself', async () => {
    const cases = [
      ['paid', /we received your payment on 1 August and we're buying your item now/],
      ['purchased', /purchased on 2 August and is on its way to our facility/],
      ['in_kenya', /arrived in Kenya on 10 August/],
      ['delivered', /delivered on 13 August\. Asante/],
      ['cancelled', /this order was cancelled/],
    ];
    for (const [status, expected] of cases) {
      sendToContact.mockClear();
      await handleInbound(trackDb({ status, delivered_at: '2026-08-13' }), contact(), { id: 'm', body: 'TRK-8821' });
      expect(sendToContact.mock.calls[0][2].text).toMatch(expected);
    }
  });

  it('reports a collected parcel as collected, not delivered', async () => {
    await handleInbound(
      trackDb({ status: 'collected', delivery_method: 'collection', delivered_at: '2026-08-24' }),
      contact(), { id: 'm', body: 'TRK-8821' });
    const reply = sendToContact.mock.calls[0][2].text;
    expect(reply).toMatch(/you collected this/i);
    expect(reply).not.toMatch(/delivered/i);
  });

  it('sends a collector to the CBD office, not after a rider', async () => {
    // Collection customers pay no last-mile fee and nobody is bringing
    // their parcel anywhere — telling them it is on its way sends them
    // to the wrong place entirely.
    await handleInbound(
      trackDb({ status: 'in_kenya', delivery_method: 'collection' }),
      contact(), { id: 'm', body: 'TRK-8821' });
    const reply = sendToContact.mock.calls[0][2].text;
    expect(reply).toMatch(/ready to collect/i);
    expect(reply).toMatch(/Stanbank House/);
    expect(reply).not.toMatch(/dispatch|on its way/i);
  });

  it('spells out an outstanding delivery fee with the till', async () => {
    await handleInbound(
      trackDb({ status: 'delivery_fee_pending', dispatched_at: null, delivery_fee_kes: '300' }),
      contact(), { id: 'm', body: 'TRK-8821' });
    const reply = sendToContact.mock.calls[0][2].text;
    expect(reply).toMatch(/delivery fee of KSh 300/);
    expect(reply).toMatch(/Buy Goods, Till \d+/);
  });

  it('is a single line, so sent.dm has nothing to flatten', async () => {
    await handleInbound(trackDb(), contact(), { id: 'm', body: 'TRK-8821' });
    const reply = sendToContact.mock.calls[0][2].text;
    expect(reply).not.toContain('\n');
    expect(flattenForFreeText(reply)).toBe(reply);
  });

  // Order numbers (ORD-3001) exist from creation, so they are the code a
  // customer holds for the whole pre-payment half of the pipeline — the
  // half where they are deciding whether to spend the money. Before
  // migration 0021 the only code that resolved here was minted at
  // payment, so a customer quoting the reference off their own quote got
  // whatever the assistant made of it.
  const ordDb = (over) => makeDb(async (sql) =>
    (sql.includes('order_code') ? { rows: [trackedOrder(over)] } : { rows: [] }));

  it('answers an ORD number in any formatting', async () => {
    const db = ordDb({ status: 'quoted', tracking_code: null, order_code: 'ORD-3001' });
    await handleInbound(db, contact(), { id: 'm', body: 'any update on ord 3001?' });
    const lookup = db.query.mock.calls.find(([sql]) => sql.includes('order_code'));
    expect(lookup[1]).toEqual(['ORD-3001']);
    expect(sendToContact.mock.calls[0][2].text).toMatch(/^ORD-3001 —/);
  });

  it('tells a quoted customer the price, not that a quote is coming', async () => {
    // The old wording for every pre-payment state was "we're still
    // finalising your quote. We'll send it here shortly." — false for a
    // quoted order (it was sent), and a promise of a message nothing was
    // going to send. That is the sentence +254790325255 was effectively
    // given four times over eighteen hours.
    await handleInbound(
      ordDb({ status: 'quoted', tracking_code: null, order_code: 'ORD-3001',
        quote_kes: '17746', quote_expires_at: '2026-09-12' }),
      contact(), { id: 'm', body: 'ORD-3001' });
    const reply = sendToContact.mock.calls[0][2].text;
    expect(reply).toMatch(/KSh 17,746/);
    expect(reply).toMatch(/held until 12 September/);
    expect(reply).not.toMatch(/finalising|shortly|will send|we'll send it/i);
  });

  it('gives a confirmed customer the amount and the till', async () => {
    // The customer with KSh 17,746 confirmed asked how to pay four
    // times. Anything that can answer that answers it.
    await handleInbound(
      ordDb({ status: 'confirmed', tracking_code: null, order_code: 'ORD-3001', quote_kes: '17746' }),
      contact(), { id: 'm', body: 'ORD-3001' });
    const reply = sendToContact.mock.calls[0][2].text;
    expect(reply).toMatch(/KSh 17,746/);
    expect(reply).toMatch(/Buy Goods/);
  });

  it('promises nothing on an order that has no price yet', async () => {
    // Nothing sweeps a 'quoting' order — every stalled-quote query in
    // the repo keys on status = 'quoted' — so a reply that promises the
    // quote is on its way is a promise with nothing behind it.
    await handleInbound(
      ordDb({ status: 'quoting', tracking_code: null, order_code: 'ORD-3001', quote_kes: null }),
      contact(), { id: 'm', body: 'ORD-3001' });
    const reply = sendToContact.mock.calls[0][2].text;
    expect(reply).toMatch(/working out the price/i);
    expect(reply).not.toMatch(/shortly|send it here|on its way to you/i);
  });

  it("will not read out somebody else's order", async () => {
    // Codes are sequential and now start at the moment an order exists,
    // so the guessable range is every order the business has taken.
    await handleInbound(
      ordDb({ contact_id: 'someone-else', tracking_code: null, order_code: 'ORD-3002' }),
      contact(), { id: 'm', body: 'ORD-3002' });
    expect(sendToContact.mock.calls[0][2].text).toMatch(/couldn't find/i);
  });
});

describe('quote confirmation', () => {
  const quotedOrder = { id: 'o1', quote_kes: '14500' };

  function confirmDb({ quotedRows }) {
    return makeDb(async (sql) => {
      if (sql.includes("status = 'quoted'") && sql.startsWith('SELECT')) {
        return { rows: quotedRows };
      }
      return { rows: [], rowCount: 1 };
    });
  }

  it.each(['yes', 'YES', 'sawa', 'ndio', 'ok', 'confirm', 'haya', 'nimekubali', 'sure', 'go ahead'])(
    'confirms the single quoted order on %j', async (word) => {
      const db = confirmDb({ quotedRows: [quotedOrder] });
      await handleInbound(db, contact(), { id: 'm', body: word });
      const update = db.query.mock.calls.find(([sql]) => sql.includes("SET status = 'confirmed'"));
      expect(update).toBeTruthy();
      expect(pushToStaff).toHaveBeenCalledWith('wa_pipeline_update', expect.objectContaining({ status: 'confirmed' }));
      expect(sendToContact.mock.calls[0][2].text).toMatch(/confirmed/i);
    }
  );

  // Accepting a quote moves money state and fires a payment demand, so
  // it is a judgement, not a prefix match. The bare digit 1 is gone —
  // "1.24kg" is a weight, not consent — and anything carrying a question,
  // a condition or more than four words goes to a person instead.
  it.each([
    '1',
    '1.24kg',
    '1 top please',
    'yes its a macbook',
    'Okay so this is the final price, no added costs?',
    'Accepted. Delivery is free at the moment, right?',
    "Okay I'll send the link by tonight",
    'Ok sure. I am currently in Kisumu',
    "okay confirm the price then I'll get back to you when i am ready",
    'Okay, allow me to visit your offices first to verify that you have a physical location',
  ])('does NOT bill anyone on %j', async (word) => {
    const db = confirmDb({ quotedRows: [quotedOrder] });
    await handleInbound(db, contact(), { id: 'm', body: word });
    const update = db.query.mock.calls.find(([sql]) => sql.includes("SET status = 'confirmed'"));
    expect(update).toBeUndefined();
  });

  it('opens the awaiting_review payment so there is something to approve', async () => {
    const db = confirmDb({ quotedRows: [quotedOrder] });
    await handleInbound(db, contact(), { id: 'm', body: 'yes' });
    const insert = db.query.mock.calls.find(([sql]) =>
      sql.includes('INSERT INTO payments') && sql.includes("'awaiting_review'"));
    expect(insert).toBeTruthy();
    expect(insert[1]).toEqual(expect.arrayContaining(['c1', 'o1', 14500]));
  });

  it('does nothing automated when several orders are quoted (ambiguous)', async () => {
    const db = confirmDb({ quotedRows: [quotedOrder, { id: 'o2', quote_kes: '9000' }] });
    await handleInbound(db, contact(), { id: 'm', body: 'yes' });
    expect(db.query.mock.calls.some(([sql]) => sql.includes("SET status = 'confirmed'"))).toBe(false);
    expect(sendToContact).not.toHaveBeenCalled();
  });

  it('does nothing on unrelated chatter', async () => {
    const db = makeDb(async () => ({ rows: [] }));
    await handleInbound(db, contact(), { id: 'm', body: 'how much for shipping shoes?' });
    expect(sendToContact).not.toHaveBeenCalled();
  });

  it('ignores blocked contacts entirely', async () => {
    const db = makeDb();
    await handleInbound(db, contact({ state: 'blocked' }), { id: 'm', body: 'yes' });
    expect(db.query).not.toHaveBeenCalled();
    expect(sendToContact).not.toHaveBeenCalled();
  });
});

// ── Collection, not just delivery ────────────────────────────────────────────
// Half our customers collect: the CBD office, or a Pickup Mtaani point.
// The prompts used to demand an estate and a street, and the length floor
// rejected the short answers a collector actually gives.
describe('collection is a first-class answer', () => {
  it('accepts a short pickup point as the destination', async () => {
    const db = makeDb(async (sql) => {
      if (sql.includes('nextval')) return { rows: [{ n: '1050' }] };
      return { rows: [], rowCount: 1 };
    });
    await handleInbound(db, contact({ state: 'awaiting_address', full_name: 'Jane Doe', customer_code: null }),
      { id: 'm', body: 'CBD' });
    const update = db.query.mock.calls.find(([sql]) => sql.includes('UPDATE wa_contacts'));
    expect(update[1]).toContain('CBD');
    expect(update[1]).toContain('active');
  });

  it('still re-asks on a non-answer', async () => {
    const db = makeDb();
    await handleInbound(db, contact({ state: 'awaiting_address', full_name: 'Jane Doe', customer_code: null }),
      { id: 'm', body: 'ok' });
    expect(db.query.mock.calls.some(([sql]) => sql.includes('delivery_address'))).toBe(false);
    // Asks for an AREA, not a named point: which Pickup Mtaani agent
    // serves it is the team's call, not the customer's.
    expect(sendToContact.mock.calls[0][2].text).toMatch(/area you'd like to collect in/i);
  });

  it('offers collection alongside delivery when it asks', async () => {
    const db = makeDb();
    await handleInbound(db, contact({ state: 'awaiting_name', full_name: null, customer_code: null }),
      { id: 'm', body: 'Jane Doe' });
    const asked = sendToContact.mock.calls.map(([, , o]) => o.text || '').join(' ');
    expect(asked).toMatch(/collect/i);
  });
});

// ── Names, questions and empty messages ──────────────────────────────────────
// From the conversation with 254794282582: asked for a full name, the
// customer replied "Can I first get the pricing and quotation ndio tujue
// details" — a fair push-back. The whole sentence went into full_name and
// they were answered "Thanks Can!".
describe('what counts as a name', () => {
  it('refuses the sentence that got stored as a name', async () => {
    const { looksLikeName } = await import('../../utils/waStateMachine.js');
    expect(looksLikeName('Can I first get the pricing and quotation ndio tujue details')).toBe(false);
  });

  it('refuses questions and requests generally', async () => {
    const { looksLikeName } = await import('../../utils/waStateMachine.js');
    for (const bad of [
      'What is the price?', 'How much?', 'Can you send pricing',
      'My name is later', 'I want to order first', 'please give me a quote',
      'naomba bei kwanza', 'Do you deliver to Kisumu',
      'Brian 254712345678', 'the quote first',
    ]) {
      expect(looksLikeName(bad), `${bad} should not be a name`).toBe(false);
    }
  });

  it('still accepts real names, including long Kenyan ones', async () => {
    const { looksLikeName } = await import('../../utils/waStateMachine.js');
    for (const good of [
      'Brian Mwarari', 'Eunice Ngasura', 'John Kamau Mwangi',
      'Faith Wanjiru Njeri Kariuki', "N'Golo Kante", 'Mary-Anne O\'Brien',
    ]) {
      expect(looksLikeName(good), `${good} should be a name`).toBe(true);
    }
  });
});

// The scripted flow runs whenever the AI is off, unconfigured, or
// throwing — and when the Claude swap left it throwing on every turn,
// this is what customers actually got. The chat that surfaced it (28
// August, 16:17–16:19) opened "Hi", asked "Is there an offer?", was told
// "your quote is being worked out now and will come through here
// shortly", replied "I haven't sent a link", and was told the same thing
// again word for word. The script was hard-coding the exact sentence
// claimsQuoteInFlight() exists to stop the model sending.
//
// Both directions matter here: don't re-ask a customer who is still
// deciding whether to buy, and don't tell them work is underway that
// isn't. A link on file is what separates the two.
describe('a customer who asks a question during signup', () => {
  // The customer's own messages, newest first, as the lookup returns them.
  const AGO = (mins) => new Date(Date.now() - mins * 60_000).toISOString();
  const withInbound = (inbound) => makeDb(async (sql) =>
    (sql.includes("direction = 'in'") ? { rows: inbound } : { rows: [] }));

  it('does not promise a quote to somebody who has sent no link', async () => {
    const db = withInbound([{ body: 'Is there an offer?', created_at: AGO(0) }]);
    await handleInbound(db, contact({ state: 'awaiting_name', full_name: null, customer_code: null }),
      { id: 'm', body: 'Is there an offer?' });
    const said = sendToContact.mock.calls[0][2].text;
    expect(said).not.toMatch(/being worked out|on its way|will come through/i);
    // It asks for the one thing that actually starts a quote.
    expect(said).toMatch(/send the link/i);
    // 254794282582 pushed back with "Can I first get the pricing and
    // quotation ndio tujue details" and was answered "Thanks Can!". The
    // name can wait until they have accepted; asking again cannot help.
    expect(said).not.toMatch(/reply with your full name/i);
    expect(db.query.mock.calls.some(([sql]) => sql.includes('full_name'))).toBe(false);
  });

  // Saying it fetches a person, which is the only reason it may be said.
  it('puts the question in front of a person, once', async () => {
    await handleInbound(withInbound([]), contact({ state: 'awaiting_name', full_name: null, customer_code: null }),
      { id: 'm', body: 'Is there an offer?' });
    expect(notifyStaff).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ dedupeKey: 'scriptedquestion:c1' }));
  });

  // The claim is true here, so it is still made: TRK-8834 sent a cart
  // link at 19:38 and the operator opened the order at 19:43.
  it('still says the quote is coming when a link really did arrive', async () => {
    const db = withInbound([
      { body: 'How much is delivery?', created_at: AGO(1) },
      { body: 'https://onelink.shein.com/49/5zw?shc=2_Rw', created_at: AGO(4) },
    ]);
    await handleInbound(db, contact({ state: 'awaiting_address', full_name: 'Brian Mwarari', customer_code: null }),
      { id: 'm', body: 'How much is delivery?' });
    const said = sendToContact.mock.calls[0][2].text;
    expect(said).toMatch(/being worked out/i);
    expect(db.query.mock.calls.some(([sql]) => sql.includes('delivery_address'))).toBe(false);
  });

  it('still re-asks on a genuine non-answer that is not a question', async () => {
    const db = makeDb();
    await handleInbound(db, contact({ state: 'awaiting_name', full_name: null, customer_code: null }),
      { id: 'm', body: '...' });
    expect(sendToContact.mock.calls[0][2].text).toMatch(/reply with your full name/i);
  });
});

describe('an empty inbound message', () => {
  it('is left in the inbox rather than answered', async () => {
    // A sticker or an unsupported attachment arrives with no body. One
    // was read as a delivery address, failed validation, and earned the
    // customer the same question twice.
    const db = makeDb();
    await handleInbound(db, contact({ state: 'awaiting_address', full_name: 'Brian', customer_code: null }),
      { id: 'm', body: '', mediaUrl: null });
    expect(sendToContact).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  it('still handles a media message that carries no caption', async () => {
    const db = makeDb();
    await handleInbound(db, contact({ state: 'awaiting_name', full_name: null, customer_code: null }),
      { id: 'm', body: '', mediaUrl: 'https://cdn.example.com/photo.jpg' });
    expect(sendToContact).toHaveBeenCalled();
  });
});

// ── SHEIN carts ──────────────────────────────────────────────────────────────
// Byrone sent product links. An operator spent eleven minutes and two
// rounds getting to a cart before anything could be quoted. Every link
// below is a real one from a real conversation.
const CART_BYRONE  = 'https://onelink.shein.com/49/5zw9b7anck7k?shc=2_RwLdztAJWDF';
const CART_OTHER   = 'https://onelink.shein.com/49/5zvze4oaj31c?shc=2_RpDnMzIZd9N';
const PRODUCT_LINK_SHEIN =
  'https://m.shein.com/Lenovo-EA400-5-4-Bluetooth-Earphones-Bone-Conduction-p-12345.html';

describe('needsSheinCart', () => {
  it('spots a product link with no cart among them', async () => {
    const { needsSheinCart } = await import('../../utils/waStateMachine.js');
    expect(needsSheinCart(PRODUCT_LINK_SHEIN)).toBe(true);
    expect(needsSheinCart(`I found some great items! ${PRODUCT_LINK_SHEIN}`)).toBe(true);
  });

  it('is satisfied by a shared cart', async () => {
    const { needsSheinCart } = await import('../../utils/waStateMachine.js');
    expect(needsSheinCart(CART_BYRONE)).toBe(false);
    expect(needsSheinCart(CART_OTHER)).toBe(false);
  });

  it('is satisfied when a cart arrives alongside product links', async () => {
    const { needsSheinCart } = await import('../../utils/waStateMachine.js');
    expect(needsSheinCart(`${PRODUCT_LINK_SHEIN}\n${CART_BYRONE}`)).toBe(false);
  });

  it('leaves every other retailer alone', async () => {
    const { needsSheinCart } = await import('../../utils/waStateMachine.js');
    for (const other of [
      'https://www.asos.com/prd/12345',
      'https://amazon.co.uk/dp/B08N5WRWNW',
      'no link at all',
      '',
    ]) {
      expect(needsSheinCart(other), other).toBe(false);
    }
  });
});

describe('asking for the SHEIN cart', () => {
  it('answers a product link with the three-dot instructions', async () => {
    const db = makeDb();
    await handleInbound(db, contact(), { id: 'm', body: PRODUCT_LINK_SHEIN });
    const said = sendToContact.mock.calls[0][2].text;
    expect(said).toMatch(/cart/i);
    expect(said).toMatch(/three dots/i);
    // and says why, so it reads as a reason rather than a rule
    expect(said).toMatch(/size or colour/i);
  });

  it('still pages staff, but says it is already in hand', async () => {
    const db = makeDb();
    await handleInbound(db, contact(), { id: 'm', body: PRODUCT_LINK_SHEIN });
    expect(notifyStaff).toHaveBeenCalledWith(db, expect.objectContaining({
      title: expect.stringMatching(/cart requested/i),
    }));
  });

  it('does not intercept a cart — that one goes to the normal flow', async () => {
    const db = makeDb();
    await handleInbound(db, contact(), { id: 'm', body: CART_BYRONE });
    const said = sendToContact.mock.calls.map(([, , o]) => o.text || '').join(' ');
    expect(said).not.toMatch(/three dots/i);
    expect(notifyStaff).toHaveBeenCalledWith(db, expect.objectContaining({
      title: expect.stringMatching(/quote needed/i),
    }));
  });

  it('says it once per burst, not once per link', async () => {
    // Customers paste three product links in a row; three identical
    // corrections is worse than the problem.
    const db = makeDb(async (sql) => {
      if (sql.includes('SELECT 1') && sql.includes('body LIKE')) return { rows: [{ '?column?': 1 }] };
      return { rows: [], rowCount: 0 };
    });
    await handleInbound(db, contact(), { id: 'm', body: PRODUCT_LINK_SHEIN });
    expect(sendToContact).not.toHaveBeenCalled();
  });

  it('stays quiet while an operator has the chat', async () => {
    const db = makeDb();
    await handleInbound(db, contact({ human_takeover_at: new Date().toISOString() }),
      { id: 'm', body: PRODUCT_LINK_SHEIN });
    const said = sendToContact.mock.calls.map(([, , o]) => o.text || '').join(' ');
    expect(said).not.toMatch(/three dots/i);
    // the alert still goes out — a person should know a link arrived
    expect(notifyStaff).toHaveBeenCalled();
  });
});

// ── Quote requests ───────────────────────────────────────────────────────────
// The new flow is "send us a link and we will quote you". Nothing after
// that link is automatic — a person prices it — so the link itself has to
// reach a person. Until this existed, the only signal was the unread
// badge in the inbox.
describe('product links page a human', () => {
  it('alerts staff when a customer sends a link', async () => {
    const db = makeDb();
    // A non-SHEIN retailer on purpose: a SHEIN product link now takes the
    // cart-request path, which has its own tests below.
    await handleInbound(db, contact(), { id: 'm', body: 'hi can you get me this https://www.asos.com/prd/12345' });
    expect(notifyStaff).toHaveBeenCalledWith(db, expect.objectContaining({
      title: expect.stringMatching(/quote needed/i),
    }));
    expect(pushToStaff).toHaveBeenCalledWith('wa_quote_request', expect.objectContaining({
      contact_id: 'c1',
    }));
  });

  it('alerts on a bare domain too, not just a full URL', async () => {
    const db = makeDb();
    await handleInbound(db, contact(), { id: 'm', body: 'amazon.co.uk/dp/B08N5WRWNW please' });
    expect(pushToStaff).toHaveBeenCalledWith('wa_quote_request', expect.anything());
  });

  it('alerts during signup, before they are a customer', async () => {
    // The likeliest moment for a link is the first real message, when
    // the contact has no name, no code and no order.
    const db = makeDb();
    await handleInbound(db, contact({ state: 'awaiting_name', full_name: null, customer_code: null }),
      { id: 'm', body: 'https://www.asos.com/prd/12345' });
    expect(pushToStaff).toHaveBeenCalledWith('wa_quote_request', expect.objectContaining({
      customer_code: null,
    }));
  });

  it('the scripted flow answers the link before asking anything', async () => {
    // AI off. The welcome invites a link, so a link is the likeliest
    // second message — and "please reply with your full name" to
    // somebody who just sent one reads like nobody looked at it.
    const db = makeDb();
    await handleInbound(db, contact({ state: 'awaiting_name', full_name: null, customer_code: null }),
      { id: 'm', body: 'https://www.asos.com/prd/12345' });
    const said = sendToContact.mock.calls.map(([, , o]) => o.text || '').join(' ');
    expect(said).toMatch(/pricing that now/i);
    expect(said).toMatch(/full name/i);
    // and the name was not stored from a URL
    expect(db.query.mock.calls.some(([sql]) => sql.includes('full_name'))).toBe(false);
  });

  it('stays quiet on ordinary text', async () => {
    const db = makeDb();
    await handleInbound(db, contact(), { id: 'm', body: 'good morning, how long does delivery take?' });
    expect(pushToStaff).not.toHaveBeenCalledWith('wa_quote_request', expect.anything());
  });

  it('stays quiet on a blocked contact', async () => {
    const db = makeDb();
    await handleInbound(db, contact({ state: 'blocked' }), { id: 'm', body: 'https://shein.com/x' });
    expect(pushToStaff).not.toHaveBeenCalled();
  });
});

// ── Gemini layer ─────────────────────────────────────────────────────────────
// waAi is module-mocked (hoisted); aiConfigured defaults to false so every
// pre-AI test above runs the deterministic paths unchanged.
// Only the model round-trips are stubbed. renderFacts stays real, so a
// test that reads the facts block sees exactly what the prompt would.
vi.mock('../../utils/waAi.js', async (importActual) => ({
  ...(await importActual()),
  aiConfigured: vi.fn(() => false),
  chatReply: vi.fn(),
  onboardingTurn: vi.fn(),
  summarizeConversation: vi.fn(async () => 'note'),
}));

// chatReply/onboardingTurn return a tagged result so a sentinel can
// never be mistaken for a message. These wrap the three shapes.
const says = (text) => ({ kind: 'reply', text });
const HANDS_OFF = { kind: 'handoff', text: null };
const OFF_TOPIC_REPLY = { kind: 'off_topic', text: null };

describe('AI-first mode', () => {
  const aiSettings = {
    markup_pct: 10, promo_active: false, promo_type: 'waive_fee',
    promo_message: '', default_delivery_fee_kes: 300,
    welcome_media_urls: [], template_map: {},
    ai_enabled: true, ai_knowledge_base: 'Delivery takes 10-14 days.',
  };

  async function ai(settings = aiSettings) {
    const waAi = await import('../../utils/waAi.js');
    waAi.aiConfigured.mockReturnValue(true);
    getWaSettings.mockResolvedValue(settings);
    return waAi;
  }

  const emptyTurn = { kind: 'reply', reply: 'Karibu! What is your full name?', full_name: null, delivery_address: null };

  it('the FIRST message goes to the AI, not the scripted welcome', async () => {
    const waAi = await ai();
    waAi.onboardingTurn.mockResolvedValueOnce(emptyTurn);
    const db = makeDb();
    await handleInbound(db, contact({ state: 'new', full_name: null, delivery_address: null, customer_code: null }),
      { id: 'm1', body: 'Hi' });
    expect(waAi.onboardingTurn).toHaveBeenCalledTimes(1);
    expect(sendToContact.mock.calls[0][2].text).toMatch(/full name/i);
    // state bookkeeping still tracks the missing field
    const update = db.query.mock.calls.find(([sql]) => sql.includes('UPDATE wa_contacts'));
    expect(update[1]).toContain('awaiting_name');
  });

  it('stores both fields from one message and finishes the signup there', async () => {
    // Two questions, not three — so a customer who volunteers their name
    // and address in one breath is done in one turn.
    const waAi = await ai();
    waAi.onboardingTurn.mockResolvedValueOnce({
      kind: 'reply',
      reply: 'Asante John! Your quote is on the way.',
      full_name: 'John Kamau',
      delivery_address: 'Greenspan Estate, Donholm, Nairobi',
    });
    const db = makeDb(async (sql) => {
      if (sql.includes('nextval')) return { rows: [{ n: '1042' }] };
      return { rows: [], rowCount: 1 };
    });
    await handleInbound(db, contact({ state: 'new', full_name: null, delivery_address: null, customer_code: null }),
      { id: 'm1', body: 'Hi, I am John Kamau, Greenspan Estate Donholm Nairobi' });
    const update = db.query.mock.calls.find(([sql]) => sql.includes('UPDATE wa_contacts'));
    expect(update[1]).toContain('active');
    expect(update[1]).toContain('John Kamau');
    expect(update[1]).toContain('Greenspan Estate, Donholm, Nairobi');
    expect(update[1]).toContain('TC-1042');
  });

  it('completes onboarding on the address: mints the code, alerts staff', async () => {
    const waAi = await ai();
    waAi.onboardingTurn.mockResolvedValueOnce({
      kind: 'reply',
      reply: 'Perfect!', full_name: null, delivery_address: 'Greenspan Estate, Donholm',
    });
    const db = makeDb(async (sql) => {
      if (sql.includes('nextval')) return { rows: [{ n: '1042' }] };
      return { rows: [], rowCount: 1 };
    });
    await handleInbound(db, contact({
      state: 'awaiting_address', full_name: 'John Kamau',
      delivery_address: null, customer_code: null,
    }), { id: 'm1', body: 'Greenspan Estate, Donholm' });
    const update = db.query.mock.calls.find(([sql]) => sql.includes('UPDATE wa_contacts'));
    expect(update[1]).toContain('active');
    expect(update[1]).toContain('TC-1042');
    expect(pushToStaff).toHaveBeenCalledWith('wa_new_customer', expect.objectContaining({ customer_code: 'TC-1042' }));
    // completion announcement went out after the AI reply
    const texts = sendToContact.mock.calls.map(([, , o]) => o.text || '');
    expect(texts.some((t) => t.includes('TC-1042'))).toBe(true);
    // No open order, so inviting a product link is the right sign-off.
    expect(texts.some((t) => /product link/i.test(t))).toBe(true);
    // And nothing anywhere asked for a way to pay.
    expect(texts.some((t) => /m-?pesa number/i.test(t))).toBe(false);
  });

  it('refuses a greeting the model offered as a name', async () => {
    // The prompt tells the model a greeting is not a name, but the rule
    // is enforced here so it holds on a bad day too.
    const waAi = await ai();
    waAi.onboardingTurn.mockResolvedValueOnce({
      kind: 'reply', reply: 'Thanks!', full_name: 'Hi',
      delivery_address: null,
    });
    const db = makeDb();
    await handleInbound(db, contact({
      state: 'awaiting_name', full_name: null, customer_code: null,
    }), { id: 'm1', body: 'Hi' });
    const update = db.query.mock.calls.find(([sql]) => sql.includes('full_name'));
    expect(update).toBeUndefined();
  });

  // Eunice's case. An operator had already placed and purchased TRK-8828
  // for her; three minutes later, finishing her profile, we told her to
  // "send us the product links". She had to ask whether anything was
  // actually happening.
  it('signs off with the order in flight, not a request for links', async () => {
    const waAi = await ai();
    waAi.onboardingTurn.mockResolvedValueOnce({
      kind: 'reply',
      reply: 'Asante!', full_name: null, delivery_address: 'Kimathi Street, CBD',
    });
    const db = makeDb(async (sql) => {
      if (sql.includes('nextval')) return { rows: [{ n: '1056' }] };
      if (sql.includes('FROM wa_orders')) {
        return { rows: [{ tracking_code: 'TRK-8828', status: 'purchased' }] };
      }
      return { rows: [], rowCount: 1 };
    });
    await handleInbound(db, contact({
      state: 'awaiting_address', full_name: 'Eunice Ngasura',
      delivery_address: null, customer_code: null,
    }), { id: 'm1', body: 'Kimathi Street, CBD' });

    const texts = sendToContact.mock.calls.map(([, , o]) => o.text || '');
    const signOff = texts.find((t) => t.includes('TC-1056'));
    expect(signOff).toMatch(/TRK-8828/);
    expect(signOff).not.toMatch(/product link/i);
  });

  it('ignores an M-Pesa number the model volunteers anyway', async () => {
    // The field is gone from the prompt and the schema, but a model that
    // has read a payment message can still hand one back. Nothing writes
    // it: we read payments off the M-Pesa statement instead.
    const waAi = await ai();
    waAi.onboardingTurn.mockResolvedValueOnce({
      kind: 'reply',
      reply: 'Got it!', full_name: null, delivery_address: null, mpesa_number: '0712 345 678',
    });
    const db = makeDb();
    await handleInbound(db, contact({
      state: 'awaiting_address', full_name: 'John', delivery_address: null,
      customer_code: null,
    }), { id: 'm1', body: 'pay from 0712 345 678' });
    expect(db.query.mock.calls.some(([sql]) => sql.includes('mpesa_number'))).toBe(false);
    // Still short an address, so nobody is a customer yet.
    expect(pushToStaff).not.toHaveBeenCalledWith('wa_new_customer', expect.anything());
  });

  it('redirects and re-asks when an off-topic question interrupts signup', async () => {
    // Regression: the sentinel used to be stripped to null and the
    // customer got total silence mid-signup.
    const waAi = await ai();
    waAi.onboardingTurn.mockResolvedValueOnce({
      kind: 'off_topic', reply: null, full_name: null, delivery_address: null,
    });
    const db = makeDb();
    await handleInbound(db, contact({
      state: 'awaiting_name', full_name: null, delivery_address: null,
      customer_code: null,
    }), { id: 'm1', body: 'what is the capital of France?' });

    const reply = sendToContact.mock.calls[0][2].text;
    expect(reply).toMatch(/only help with Thapsus Cargo/i);
    // ...and it still moves signup along
    expect(reply).toMatch(/full name/i);
    expect(notifyStaff).not.toHaveBeenCalled();
  });

  it('hands a mid-signup complaint to a human instead of going quiet', async () => {
    const waAi = await ai();
    waAi.onboardingTurn.mockResolvedValueOnce({
      kind: 'handoff', reply: null, full_name: null, delivery_address: null,
    });
    const db = makeDb();
    await handleInbound(db, contact({
      state: 'awaiting_address', full_name: 'John', delivery_address: null,
      customer_code: null,
    }), { id: 'm1', body: 'your driver was rude to my sister last week' });

    expect(sendToContact.mock.calls[0][2].text).toMatch(/team will reply/i);
    expect(db.query.mock.calls.some(([sql]) => sql.includes('human_takeover_at = NOW()'))).toBe(true);
    expect(notifyStaff).toHaveBeenCalledWith(db, expect.objectContaining({
      title: expect.stringMatching(/needs a human/i),
    }));
  });

  it('falls back to the scripted welcome when the AI throws', async () => {
    const waAi = await ai();
    waAi.onboardingTurn.mockRejectedValueOnce(new Error('Gemini HTTP 500'));
    const db = makeDb();
    await handleInbound(db, contact({ state: 'new', full_name: null, customer_code: null }), { id: 'm1', body: 'Hi' });
    // scripted welcome ran instead
    const update = db.query.mock.calls.find(([sql]) => sql.includes('UPDATE wa_contacts'));
    expect(update[1]).toContain('awaiting_name');
    expect(sendToContact.mock.calls.some(([, , o]) => /Karibu Thapsus Cargo/.test(o.text || ''))).toBe(true);
  });

  it('answers a fall-through question for an active contact', async () => {
    const waAi = await ai();
    waAi.chatReply.mockResolvedValueOnce(says('Delivery usually takes 10-14 days. Asante!'));
    const db = makeDb(async (sql) => {
      if (sql.includes('FROM wa_messages')) return { rows: [{ direction: 'in', body: 'Hi' }] };
      return { rows: [] };
    });
    await handleInbound(db, contact(), { id: 'm1', body: 'How long does delivery take?' });
    expect(sendToContact).toHaveBeenCalledTimes(1);
    expect(sendToContact.mock.calls[0][2].text).toMatch(/10-14 days/);
  });

  it('acknowledges the customer on HANDOFF instead of going silent', async () => {
    const waAi = await ai();
    waAi.chatReply.mockResolvedValueOnce(HANDS_OFF);
    const db = makeDb(async () => ({ rows: [] }));
    await handleInbound(db, contact(), { id: 'm1', body: 'I want to complain' });
    expect(sendToContact.mock.calls[0][2].text).toMatch(/team will reply/i);
  });

  it('stays silent when the AI errors (inbox keeps the message)', async () => {
    const waAi = await ai();
    waAi.chatReply.mockRejectedValueOnce(new Error('Gemini HTTP 500'));
    await handleInbound(makeDb(async () => ({ rows: [] })), contact(), { id: 'm2', body: 'random question' });
    expect(sendToContact).not.toHaveBeenCalled();
  });

  it('tracking codes still bypass the AI entirely', async () => {
    const waAi = await ai();
    const db = makeDb(async (sql) => {
      if (sql.includes('tracking_code')) {
        return { rows: [{ id: 'o1', contact_id: 'c1', status: 'paid', tracking_code: 'TRK-8821',
          paid_at: '2026-08-01', purchased_at: null, arrived_at: null,
          dispatched_at: null, delivered_at: null,
          delivery_fee_waived: false, delivery_fee_kes: null, customer_code: 'TC-1042' }] };
      }
      return { rows: [] };
    });
    await handleInbound(db, contact(), { id: 'm1', body: 'TRK-8821' });
    expect(waAi.chatReply).not.toHaveBeenCalled();
    expect(sendToContact.mock.calls[0][2].text).toContain('TRK-8821');
  });
});

describe('AI order awareness', () => {
  async function ai() {
    const waAi = await import('../../utils/waAi.js');
    waAi.aiConfigured.mockReturnValue(true);
    getWaSettings.mockResolvedValue({
      markup_pct: 10, promo_active: false, promo_type: 'waive_fee',
      promo_message: '', default_delivery_fee_kes: 300,
      welcome_media_urls: [], template_map: {},
      ai_enabled: true, ai_knowledge_base: 'Delivery takes 10-14 days.',
    });
    return waAi;
  }

  const orderRows = [{
    tracking_code: 'TRK-8821', status: 'dispatched', quote_kes: '17094',
    delivery_fee_kes: 300, delivery_fee_waived: false, delivery_fee_paid_at: '2026-08-11',
    paid_at: '2026-08-01', purchased_at: '2026-08-02', arrived_at: '2026-08-10',
    dispatched_at: '2026-08-11', delivered_at: null, created_at: '2026-08-01',
  }];

  function dbWithOrders(rows = orderRows) {
    return makeDb(async (sql) => {
      if (sql.includes('FROM wa_orders')) return { rows };
      if (sql.includes('FROM wa_messages')) return { rows: [] };
      return { rows: [] };
    });
  }

  it('passes the live order summary to the AI for a vague "where is my parcel?"', async () => {
    const waAi = await ai();
    waAi.chatReply.mockResolvedValueOnce(says('Your parcel TRK-8821 is out for delivery!'));
    await handleInbound(dbWithOrders(), contact(), { id: 'm1', body: 'where is my parcel?' });

    const ctx = waAi.chatReply.mock.calls[0][0].orderContext;
    expect(ctx).toContain('TRK-8821');
    expect(ctx).toContain('Out for delivery');
    expect(ctx).toContain('17,094');
    expect(ctx).toMatch(/paid 1 Aug/);
    expect(sendToContact.mock.calls[0][2].text).toContain('TRK-8821');
  });

  it('flags an outstanding delivery fee in the context', async () => {
    const waAi = await ai();
    waAi.chatReply.mockResolvedValueOnce(says('reply'));
    await handleInbound(dbWithOrders([{
      ...orderRows[0], status: 'delivery_fee_pending',
      dispatched_at: null, delivery_fee_paid_at: null,
    }]), contact(), { id: 'm1', body: 'any update?' });
    expect(waAi.chatReply.mock.calls[0][0].orderContext).toContain('delivery fee outstanding: KSh 300');
  });

  it('reports no orders on file when the customer has none', async () => {
    const waAi = await ai();
    waAi.chatReply.mockResolvedValueOnce(says('reply'));
    await handleInbound(dbWithOrders([]), contact(), { id: 'm1', body: 'hello' });
    expect(waAi.chatReply.mock.calls[0][0].orderContext).toBe('(none on file)');
  });

  it('still prefers the deterministic lookup for an exact TRK code', async () => {
    const waAi = await ai();
    const db = makeDb(async (sql) => {
      if (sql.includes('tracking_code = $1')) return { rows: [{
        id: 'o1', contact_id: 'c1', status: 'dispatched', tracking_code: 'TRK-8821',
        paid_at: '2026-08-01', purchased_at: null, arrived_at: null,
        dispatched_at: '2026-08-11', delivered_at: null,
        delivery_fee_waived: false, delivery_fee_kes: null, customer_code: 'TC-1042',
      }] };
      return { rows: [] };
    });
    await handleInbound(db, contact(), { id: 'm1', body: 'TRK-8821' });
    expect(waAi.chatReply).not.toHaveBeenCalled();
    expect(sendToContact.mock.calls[0][2].text).toContain('TRK-8821');
  });
});

// +447428777090. "Hi" → "How long does it take?" → "How do I pay?",
// with no link and no order anywhere, and the assistant replied "your
// quote is being worked out now and will come through here shortly".
// Nothing was. They were left waiting on a message nobody would send,
// and the payment question — answered in full by the knowledge base —
// was never answered at all.
//
// The model had the transcript and the order list. What it did not have
// was any statement of what is TRUE of our system, so it inferred an
// order from how far along the chat felt. These pin the facts block that
// replaces the inference.
describe('what the assistant is told about the state of a conversation', () => {
  const aiSettings = {
    markup_pct: 10, promo_active: false, promo_type: 'waive_fee',
    promo_message: '', default_delivery_fee_kes: 300,
    welcome_media_urls: [], template_map: {},
    ai_enabled: true, ai_knowledge_base: 'PAYING\nWe take payment by M-Pesa.',
  };

  async function ai() {
    const waAi = await import('../../utils/waAi.js');
    waAi.aiConfigured.mockReturnValue(true);
    getWaSettings.mockResolvedValue(aiSettings);
    return waAi;
  }

  // orders → rows from wa_orders; inbound → the customer's own messages,
  // newest first, as the query returns them.
  const AGO = (mins) => new Date(Date.now() - mins * 60_000).toISOString();
  function db({ orders = [], inbound = [] } = {}) {
    return makeDb(async (sql) => {
      if (sql.includes('FROM wa_orders')) return { rows: orders };
      if (sql.includes("direction = 'in'")) return { rows: inbound };
      return { rows: [] };
    });
  }

  it('tells the onboarding turn that nothing is being priced when no link ever came', async () => {
    const waAi = await ai();
    waAi.onboardingTurn.mockResolvedValueOnce({
      kind: 'reply', reply: 'We take payment by M-Pesa. Send your cart link and we will quote you.',
      full_name: null, delivery_address: null,
    });
    await handleInbound(
      db({ inbound: [
        { body: 'How do I pay?', created_at: AGO(1) },
        { body: 'How long does it take?', created_at: AGO(5) },
        { body: 'Hi', created_at: AGO(9) },
      ] }),
      contact({ state: 'awaiting_name', full_name: null, delivery_address: null, customer_code: null }),
      { id: 'm3', body: 'How do I pay?' }
    );

    const facts = waAi.onboardingTurn.mock.calls[0][0].facts;
    expect(facts).toMatch(/never sent us a product or cart link/);
    expect(facts).toMatch(/do NOT say a quote is coming/);
    expect(facts).toMatch(/Still missing from their profile: full name/);
  });

  // TRK-8834: the cart link arrived at 19:38 and the operator did not
  // open the order until 19:43. For those five minutes the customer was
  // genuinely waiting on a quote and there was no row to prove it — so
  // the fact is keyed on the link, which is the event the customer can
  // actually see.
  it('says a quote IS coming from the link alone, before any order row exists', async () => {
    const waAi = await ai();
    waAi.chatReply.mockResolvedValueOnce(says('The team is pricing it now.'));
    await handleInbound(
      db({ orders: [], inbound: [{ body: 'https://onelink.shein.com/49/5zw?shc=2_Rw', created_at: AGO(2) }] }),
      contact(), { id: 'm1', body: 'and how long does it take?' }
    );

    const facts = waAi.chatReply.mock.calls[0][0].facts;
    expect(facts).toMatch(/quote IS genuinely being prepared/);
    expect(facts).toMatch(/Do NOT ask for a link again/);
    // and the reply that the old rule called a hallucination goes out
    expect(sendToContact.mock.calls[0][2].text).toBe('The team is pricing it now.');
  });

  it('counts a link sent earlier in the chat, not only the message in hand', async () => {
    const waAi = await ai();
    waAi.chatReply.mockResolvedValueOnce(says('reply'));
    await handleInbound(
      db({ inbound: [
        { body: 'and how long?', created_at: AGO(1) },
        { body: 'https://www.next.co.uk/p/123', created_at: AGO(6) },
      ] }),
      contact(), { id: 'm1', body: 'and how long?' }
    );
    expect(waAi.chatReply.mock.calls[0][0].facts).toMatch(/quote IS genuinely being prepared/);
  });

  // The promise had no deadline on it, so it never stopped being made.
  // +254790325255 sent a cart at 21:02 on 5 September 2026; the staff page
  // about it failed delivery and nobody knew; the assistant, reading a
  // fact that was still technically true, told her the quote was coming
  // at 21:02, 21:06, 10:02 and 13:09 before it finally went out at 15:22
  // — eighteen hours. In between she wrote "No you're not getting my
  // question, I'm still waiting on the quote so that I pay".
  //
  // The unanswered-inbound sweep never fired for her either: the
  // assistant answered every message, so the conversation's last message
  // was always ours. Nothing in the system was measuring the one interval
  // she could see.
  it('stops promising a quote once the wait has outrun the promise window', async () => {
    const waAi = await ai();
    waAi.chatReply.mockResolvedValueOnce(says('reply'));
    await handleInbound(
      db({
        orders: [],
        inbound: [{ body: 'https://onelink.shein.com/51/614cv6o2fsip', created_at: AGO(18 * 60) }],
      }),
      contact(), { id: 'm1', body: 'how long is this supposed to take?' }
    );
    const facts = waAi.chatReply.mock.calls[0][0].facts;
    expect(facts).toMatch(/This is LATE/);
    expect(facts).toMatch(/18 hours ago/);
    expect(facts).not.toMatch(/quote IS genuinely being prepared/);
  });

  it('still promises inside the window — a page nobody has had time to act on is not late', async () => {
    // The window is deliberately much longer than the sweeper's page, so
    // the assistant goes quiet on the subject only after a person has had
    // real time to act, not the moment the page fires. Getting this
    // backwards would hand off the warmest lead in the business over a
    // ten-minute wait.
    const waAi = await ai();
    waAi.chatReply.mockResolvedValueOnce(says('reply'));
    await handleInbound(
      db({ orders: [], inbound: [{ body: 'https://www.next.co.uk/p/123', created_at: AGO(45) }] }),
      contact(), { id: 'm1', body: 'any update?' }
    );
    const facts = waAi.chatReply.mock.calls[0][0].facts;
    expect(facts).toMatch(/quote IS genuinely being prepared/);
    expect(facts).not.toMatch(/This is LATE/);
  });

  // Once we have answered, the wait is over. Saying "your quote is
  // coming" to someone holding their quote is as wrong as inventing one.
  it('stops claiming a quote is coming once one has been sent', async () => {
    const waAi = await ai();
    waAi.chatReply.mockResolvedValueOnce(says('reply'));
    await handleInbound(
      db({
        orders: [{ status: 'quoted', quoted_at: AGO(3) }],
        inbound: [{ body: 'https://www.next.co.uk/p/123', created_at: AGO(30) }],
      }),
      contact(), { id: 'm1', body: 'hi' }
    );
    const facts = waAi.chatReply.mock.calls[0][0].facts;
    expect(facts).toMatch(/already been quoted or is too old/);
    expect(facts).not.toMatch(/quote IS genuinely being prepared/);
  });

  it('marks a first-ever message as one', async () => {
    const waAi = await ai();
    waAi.onboardingTurn.mockResolvedValueOnce({
      kind: 'reply', reply: 'Karibu!', full_name: null, delivery_address: null,
    });
    await handleInbound(
      db({ inbound: [{ body: 'Hi', created_at: AGO(0) }] }),
      contact({ state: 'new', full_name: null, delivery_address: null, customer_code: null }),
      { id: 'm1', body: 'Hi' }
    );
    expect(waAi.onboardingTurn.mock.calls[0][0].facts).toMatch(/FIRST message they have ever sent/);
  });

  it('pages staff when the guard caught a promise we could not keep', async () => {
    const waAi = await ai();
    waAi.onboardingTurn.mockResolvedValueOnce({
      kind: 'reply', reply: 'We take payment by M-Pesa. Send your cart link.',
      full_name: null, delivery_address: null, falseClaim: true,
    });
    await handleInbound(
      db({ inbound: [{ body: 'How do I pay?', created_at: AGO(0) }] }),
      contact({ state: 'awaiting_name', full_name: null, delivery_address: null, customer_code: null }),
      { id: 'm1', body: 'How do I pay?' }
    );
    expect(notifyStaff).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ title: expect.stringMatching(/quote that does not exist/i) }));
  });
});

describe('staff WhatsApp alerts', () => {
  async function ai() {
    const waAi = await import('../../utils/waAi.js');
    waAi.aiConfigured.mockReturnValue(true);
    getWaSettings.mockResolvedValue({
      markup_pct: 10, promo_active: false, promo_type: 'waive_fee',
      promo_message: '', default_delivery_fee_kes: 300,
      welcome_media_urls: [], template_map: {},
      ai_enabled: true, ai_knowledge_base: 'kb',
    });
    return waAi;
  }

  it('alerts staff when a customer says they have paid, with the M-Pesa ref', async () => {
    const waAi = await ai();
    const db = makeDb(async () => ({ rows: [] }));
    await handleInbound(db, contact(), { id: 'm1', body: 'I have paid, SHL9XK2QRT confirmed Ksh 17,094' });
    expect(notifyStaff).toHaveBeenCalledWith(db, expect.objectContaining({
      title: expect.stringMatching(/payment claimed/i),
      detail: expect.stringContaining('SHL9XK2QRT'),
    }));
    // The customer hears that it's being checked — never the handoff line,
    // which reads like nobody can see their money.
    expect(sendToContact.mock.calls[0][2].text).toMatch(/verifying it with M-Pesa/i);
    expect(sendToContact.mock.calls[0][2].text).toContain('SHL9XK2QRT');
    expect(sendToContact.mock.calls[0][2].text).not.toMatch(/colleague/i);
    expect(waAi.chatReply).not.toHaveBeenCalled();
  });

  it('stamps the M-Pesa ref on the open payment so the operator can match it', async () => {
    await ai();
    const db = makeDb(async (sql) => {
      if (sql.includes('wa_contact_id = $1') && sql.includes('payments')) {
        return { rows: [{ id: 'PAY-1', amount_due_kes: '17094' }] };
      }
      return { rows: [], rowCount: 1 };
    });
    await handleInbound(db, contact(), { id: 'm1', body: 'I have paid, SHL9XK2QRT confirmed Ksh 17,094' });
    const stamp = db.query.mock.calls.find(([sql]) => sql.includes('SET mpesa_reference'));
    expect(stamp[1]).toEqual(['PAY-1', 'SHL9XK2QRT']);
    expect(sendToContact.mock.calls[0][2].text).toMatch(/KSh 17,094/);
  });

  it('only reassures once per burst of payment messages', async () => {
    await ai();
    const db = makeDb(async (sql) => {
      if (sql.includes("direction = 'out'")) return { rows: [{ '?column?': 1 }] };
      return { rows: [] };
    });
    await handleInbound(db, contact(), { id: 'm1', body: 'I have paid' });
    expect(sendToContact).not.toHaveBeenCalled();
    expect(notifyStaff).toHaveBeenCalled(); // staff still get paged
  });

  it.each(['nimelipa', 'I paid already', 'nimetuma the money'])(
    'recognises "%s" as a payment claim', async (msg) => {
      await ai();
      await handleInbound(makeDb(async () => ({ rows: [] })), contact(), { id: 'm1', body: msg });
      expect(notifyStaff).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        title: expect.stringMatching(/payment claimed/i),
      }));
    }
  );

  it.each(['I sent the link', 'can I pay with Lipa na M-Pesa?'])(
    'does not read "%s" as a payment claim', async (msg) => {
      const waAi = await ai();
      waAi.chatReply.mockResolvedValueOnce(says('Sure — here is how.'));
      await handleInbound(makeDb(async () => ({ rows: [] })), contact(), { id: 'm1', body: msg });
      expect(notifyStaff).not.toHaveBeenCalled();
      expect(waAi.chatReply).toHaveBeenCalled();
    }
  );

  it('alerts staff when the AI hands off (customer wants a human)', async () => {
    const waAi = await ai();
    waAi.chatReply.mockResolvedValueOnce(HANDS_OFF);
    await handleInbound(makeDb(async () => ({ rows: [] })), contact(),
      { id: 'm1', body: 'Can I speak to a customer rep?' });
    expect(notifyStaff).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      title: expect.stringMatching(/needs a human/i),
      detail: expect.stringContaining('customer rep'),
    }));
    // and the customer is told a person is coming
    expect(sendToContact.mock.calls[0][2].text).toMatch(/team will reply/i);
  });

  it('redirects an off-topic message without paging anyone', async () => {
    const waAi = await ai();
    waAi.chatReply.mockResolvedValueOnce(OFF_TOPIC_REPLY);
    const db = makeDb(async () => ({ rows: [] }));
    await handleInbound(db, contact(), { id: 'm1', body: 'who won the match last night?' });

    const reply = sendToContact.mock.calls[0][2].text;
    expect(reply).toMatch(/only help with Thapsus Cargo/i);
    expect(reply).toMatch(/product link/i);
    // The three things that separate this from a handoff.
    expect(notifyStaff).not.toHaveBeenCalled();
    expect(db.query.mock.calls.some(([sql]) => sql.includes('human_takeover_at = NOW()'))).toBe(false);
  });

  // Still only one redirect an hour — but silence is not the fallback.
  // A second off-topic in the hour is more likely a real customer being
  // misread twice than a wrong number texting twice, and before this the
  // misread customer got nothing at all: no reply, no alert, no takeover.
  it('says nothing twice in an hour, but pages a person instead of going quiet', async () => {
    const waAi = await ai();
    waAi.chatReply.mockResolvedValueOnce(OFF_TOPIC_REPLY);
    const db = makeDb(async (sql) =>
      (sql.includes("direction = 'out'") ? { rows: [{ '?column?': 1 }] } : { rows: [] }));
    await handleInbound(db, contact(), { id: 'm1', body: 'tell me a joke' });
    expect(sendToContact).not.toHaveBeenCalled();
    expect(notifyStaff).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ title: expect.stringMatching(/probably not off-topic/i) }));
  });

  it('does not alert on an ordinary answered question', async () => {
    const waAi = await ai();
    waAi.chatReply.mockResolvedValueOnce(says('We deliver in 10-14 days.'));
    await handleInbound(makeDb(async () => ({ rows: [] })), contact(), { id: 'm1', body: 'how long is delivery?' });
    expect(notifyStaff).not.toHaveBeenCalled();
  });

  it('alerts staff and gives till instructions when a quote is confirmed', async () => {
    process.env.MPESA_TILL_NUMBER = '5530500';
    const db = makeDb(async (sql) => {
      if (sql.includes("status = 'quoted'") && sql.startsWith('SELECT')) {
        return { rows: [{ id: 'o1', quote_kes: '17094' }] };
      }
      return { rows: [], rowCount: 1 };
    });
    await handleInbound(db, contact(), { id: 'm1', body: 'yes' });
    expect(notifyStaff).toHaveBeenCalledWith(db, expect.objectContaining({
      title: expect.stringMatching(/order confirmed/i),
    }));
    const text = sendToContact.mock.calls[0][2].text;
    expect(text).toContain('5530500');
    expect(text).not.toMatch(/enter your PIN/i);   // STK language is gone
  });
});

describe('human takeover and AI memory', () => {
  async function ai(extra = {}) {
    const waAi = await import('../../utils/waAi.js');
    waAi.aiConfigured.mockReturnValue(true);
    getWaSettings.mockResolvedValue({
      markup_pct: 10, promo_active: false, promo_type: 'waive_fee',
      promo_message: '', default_delivery_fee_kes: 300,
      welcome_media_urls: [], template_map: {},
      ai_enabled: true, ai_knowledge_base: 'kb', ai_resume_after_minutes: 120,
      ...extra,
    });
    return waAi;
  }

  // db where the previous message was `minutesAgo` old
  function dbSince(minutesAgo) {
    return makeDb(async (sql) => {
      if (sql.includes('MAX(created_at)')) {
        return { rows: [{ at: new Date(Date.now() - minutesAgo * 60_000).toISOString() }] };
      }
      if (sql.includes('count(*)')) return { rows: [{ n: 0 }] };
      return { rows: [] };
    });
  }

  it('tells the customer a human is coming, hands over, and alerts staff', async () => {
    const waAi = await ai();
    waAi.chatReply.mockResolvedValueOnce(HANDS_OFF);
    const db = makeDb(async (sql) => {
      if (sql.includes('count(*)')) return { rows: [{ n: 0 }] };
      return { rows: [] };
    });
    await handleInbound(db, contact(), { id: 'm1', body: 'Can I speak to a customer rep?' });

    // customer is acknowledged, not left in silence
    expect(sendToContact.mock.calls[0][2].text).toMatch(/team will reply/i);
    // thread handed to the humans
    expect(db.query.mock.calls.some(([sql]) => sql.includes('human_takeover_at = NOW()'))).toBe(true);
    expect(notifyStaff).toHaveBeenCalledWith(db, expect.objectContaining({
      title: expect.stringMatching(/needs a human/i),
    }));
  });

  it('stays quiet mid-signup too while a human has the chat', async () => {
    // The takeover check used to sit after the onboarding branch, so a
    // handed-over signup kept getting questionnaire messages.
    const waAi = await ai();
    const db = dbSince(30);
    await handleInbound(db, contact({
      state: 'awaiting_address', human_takeover_at: new Date().toISOString(),
      full_name: 'John', delivery_address: null, customer_code: null,
    }), { id: 'm1', body: 'Donholm, Nairobi' });
    expect(waAi.onboardingTurn).not.toHaveBeenCalled();
    expect(sendToContact).not.toHaveBeenCalled();
  });

  it('stays quiet while a human has the chat (within the resume window)', async () => {
    const waAi = await ai();
    const db = dbSince(30); // last message 30 min ago, window is 120
    await handleInbound(db, contact({ human_takeover_at: new Date().toISOString() }),
      { id: 'm1', body: 'any update?' });
    expect(waAi.chatReply).not.toHaveBeenCalled();
    expect(sendToContact).not.toHaveBeenCalled();
  });

  it('resumes automatically after the quiet period', async () => {
    const waAi = await ai();
    waAi.chatReply.mockResolvedValueOnce(says('Karibu back! How can I help?'));
    const db = dbSince(180); // 3h of silence, window is 120 min
    await handleInbound(db, contact({ human_takeover_at: new Date(Date.now() - 3 * 3600_000).toISOString() }),
      { id: 'm1', body: 'hello again' });
    expect(db.query.mock.calls.some(([sql]) => sql.includes('human_takeover_at = NULL'))).toBe(true);
    expect(waAi.chatReply).toHaveBeenCalled();
    expect(sendToContact.mock.calls[0][2].text).toMatch(/karibu back/i);
  });

  it('honours a custom resume window', async () => {
    const waAi = await ai({ ai_resume_after_minutes: 15 });
    waAi.chatReply.mockResolvedValueOnce(says('back'));
    const db = dbSince(20); // 20 min silence vs a 15 min window
    await handleInbound(db, contact({ human_takeover_at: new Date().toISOString() }),
      { id: 'm1', body: 'hi' });
    expect(waAi.chatReply).toHaveBeenCalled();
  });

  it('deterministic replies still work while a human has the chat', async () => {
    const waAi = await ai();
    const db = makeDb(async (sql) => {
      if (sql.includes('MAX(created_at)')) return { rows: [{ at: new Date().toISOString() }] };
      if (sql.includes('tracking_code = $1')) return { rows: [{
        id: 'o1', contact_id: 'c1', status: 'dispatched', tracking_code: 'TRK-8821',
        paid_at: '2026-08-01', purchased_at: null, arrived_at: null,
        dispatched_at: '2026-08-11', delivered_at: null,
        delivery_fee_waived: false, delivery_fee_kes: null, customer_code: 'TC-1042',
      }] };
      return { rows: [] };
    });
    await handleInbound(db, contact({ human_takeover_at: new Date().toISOString() }),
      { id: 'm1', body: 'TRK-8821' });
    expect(sendToContact.mock.calls[0][2].text).toContain('TRK-8821');
    expect(waAi.chatReply).not.toHaveBeenCalled();
  });

  it('passes the stored memory note and customer profile into the prompt', async () => {
    const waAi = await ai();
    waAi.chatReply.mockResolvedValueOnce(says('sure'));
    const db = makeDb(async (sql) => {
      if (sql.includes('count(*)')) return { rows: [{ n: 0 }] };
      return { rows: [] };
    });
    await handleInbound(db, contact({
      ai_summary: 'Prefers Pickup Mtaani. Buys trainers, size 42.',
      delivery_address: 'C1 Muraya Road, Ongata Rongai',
      created_at: '2026-06-01T00:00:00Z',
    }), { id: 'm1', body: 'what did I order last time?' });

    const args = waAi.chatReply.mock.calls[0][0];
    expect(args.summary).toMatch(/Pickup Mtaani/);
    expect(args.profile).toContain('TC-1042');
    expect(args.profile).toContain('Muraya Road');
  });

  it('refreshes the memory note once enough new messages have accumulated', async () => {
    const waAi = await ai();
    waAi.chatReply.mockResolvedValueOnce(says('ok'));
    waAi.summarizeConversation.mockResolvedValueOnce('Wants shoes. Prefers Rongai delivery.');
    const db = makeDb(async (sql) => {
      if (sql.includes('count(*)')) return { rows: [{ n: 25 }] };  // over the threshold
      return { rows: [] };
    });
    await handleInbound(db, contact(), { id: 'm1', body: 'hi' });
    await new Promise((r) => setTimeout(r, 10)); // background refresh
    expect(waAi.summarizeConversation).toHaveBeenCalled();
    expect(db.query.mock.calls.some(([sql]) => sql.includes('SET ai_summary'))).toBe(true);
  });
});

// ── Paid-claim ordering + state awareness ────────────────────────────────────
// "ok, I have paid" opens with a confirm word, and used to hit the
// quote-confirm branch first — the customer got the till instructions
// again for money they had just sent. And a claim about money already
// settled got "we're verifying it now", which reads as nobody having
// their money.
describe('paid claims vs quote confirmation', () => {
  it('routes "ok I have paid" to the payment branch, not the confirm branch', async () => {
    const db = makeDb(async (sql) => {
      // A quoted order exists — the confirm branch WOULD have fired.
      if (sql.includes("status = 'quoted'") && sql.startsWith('SELECT')) {
        return { rows: [{ id: 'o1', quote_kes: '14500' }] };
      }
      return { rows: [], rowCount: 1 };
    });
    await handleInbound(db, contact(), { id: 'm', body: 'ok I have paid' });
    expect(db.query.mock.calls.some(([sql]) => sql.includes("SET status = 'confirmed'"))).toBe(false);
    expect(notifyStaff).toHaveBeenCalledWith(db, expect.objectContaining({
      title: expect.stringMatching(/payment claimed/i),
    }));
    expect(sendToContact.mock.calls[0][2].text).toMatch(/verifying it with M-Pesa/i);
  });

  it('answers a claim about settled money with the parcel status, and pages no one', async () => {
    const db = makeDb(async (sql) => {
      // No open payment…
      if (sql.includes('payments') && sql.includes('wa_contact_id')) return { rows: [] };
      // …and the latest order is already purchased.
      if (sql.includes('FROM wa_orders') && sql.includes('contact_id = $1')) {
        return { rows: [{ id: 'o1', status: 'purchased', tracking_code: 'TRK-8821', purchased_at: '2026-08-12' }] };
      }
      return { rows: [], rowCount: 1 };
    });
    // The deterministic branch answers and returns, so the assistant is
    // never reached — but stub it anyway, because an unstubbed throw is
    // now a staff page rather than a silent log.
    (await import('../../utils/waAi.js')).chatReply.mockResolvedValueOnce(says('unused'));
    await handleInbound(db, contact(), { id: 'm', body: 'I have paid, any update?' });
    expect(notifyStaff).not.toHaveBeenCalled();
    const said = sendToContact.mock.calls[0][2].text;
    expect(said).toContain('TRK-8821');
    expect(said).toMatch(/confirmed — nothing is pending/i);
    expect(said).not.toMatch(/verifying it with M-Pesa/i);
  });

  // The approved quote template tells the customer "Reply to accept".
  it.each(['accept', 'Accepted', 'nakubali'])(
    'treats "%s" as a quote confirmation', async (word) => {
      const db = makeDb(async (sql) => {
        if (sql.includes("status = 'quoted'") && sql.startsWith('SELECT')) {
          return { rows: [{ id: 'o1', quote_kes: '14500' }] };
        }
        return { rows: [], rowCount: 1 };
      });
      await handleInbound(db, contact(), { id: 'm', body: word });
      expect(db.query.mock.calls.some(([sql]) => sql.includes("SET status = 'confirmed'"))).toBe(true);
    }
  );
});

// ── Tracking lookups are scoped to the asking contact ────────────────────────
// Codes are sequential; before this, any onboarded contact could walk
// TRK-8800, TRK-8801, … and read every parcel's status, dates and
// outstanding fee.
describe('tracking privacy', () => {
  it("answers someone else's code exactly like a code that doesn't exist", async () => {
    const db = makeDb(async (sql) => {
      if (sql.includes('tracking_code = $1')) {
        return { rows: [{ id: 'o9', contact_id: 'someone-else', status: 'in_kenya',
          tracking_code: 'TRK-8800', delivery_fee_kes: '300', customer_code: 'TC-9' }] };
      }
      return { rows: [] };
    });
    await handleInbound(db, contact(), { id: 'm', body: 'TRK-8800' });
    const reply = sendToContact.mock.calls[0][2].text;
    expect(reply).toMatch(/couldn't find/i);
    expect(reply).not.toMatch(/arrived|fee|KSh/i);
  });
});

// ── Expired quotes are not auto-confirmable ──────────────────────────────────
describe('quote expiry', () => {
  it('declines to auto-confirm an expired quote, tells the customer, pages staff', async () => {
    const db = makeDb(async (sql) => {
      if (sql.includes("status = 'quoted'") && sql.trim().startsWith('SELECT')) {
        return { rows: [{ id: 'o1', quote_kes: '14500', tracking_code: null,
          quote_expires_at: new Date(Date.now() - 24 * 3600_000).toISOString() }] };
      }
      return { rows: [], rowCount: 1 };
    });
    await handleInbound(db, contact(), { id: 'm', body: 'yes' });
    expect(db.query.mock.calls.some(([sql]) => sql.includes("SET status = 'confirmed'"))).toBe(false);
    expect(notifyStaff).toHaveBeenCalledWith(db, expect.objectContaining({
      title: expect.stringMatching(/expired quote/i),
    }));
    expect(sendToContact.mock.calls[0][2].text).toMatch(/re-checking the price/i);
  });

  it('still auto-confirms a quote inside its validity window', async () => {
    const db = makeDb(async (sql) => {
      if (sql.includes("status = 'quoted'") && sql.trim().startsWith('SELECT')) {
        return { rows: [{ id: 'o1', quote_kes: '14500', tracking_code: null,
          quote_expires_at: new Date(Date.now() + 3 * 24 * 3600_000).toISOString() }] };
      }
      return { rows: [], rowCount: 1 };
    });
    await handleInbound(db, contact(), { id: 'm', body: 'yes' });
    expect(db.query.mock.calls.some(([sql]) => sql.includes("SET status = 'confirmed'"))).toBe(true);
  });
});


// Predicates that decide money or re-ask a customer. Each case below is a
// real message from the production corpus or a Swahili form of one.
describe('what counts as accepting a quote', () => {
  it.each(['Yes', 'yes', 'Sawa', 'Sawa sawa', 'Ndio', 'Haya', 'Nakubali', 'Nimekubali',
           'Ni sawa', 'Niko sawa', 'Poa', 'Twende', 'Sure', 'Fine', 'Go ahead',
           'Accept', 'Confirmed', 'Proceed', 'Yes please'])(
    'accepts %j', (t) => expect(isUnqualifiedConfirm(t)).toBe(true));

  // A prefix match is not consent. The bare digit 1 made a weight, a
  // quantity and a shoe size into an accepted quote.
  it.each(['1', '1.24kg', '1 top please', 'yes its a macbook',
           'Okay so this is the final price, no added costs?',
           'Accepted. Delivery is free at the moment, right?',
           "Okay I'll send the link by tonight",
           "Okay thanks... I'll resend another link once I've edited it",
           'Ok sure. I am currently in Kisumu',
           "okay confirm the price then I'll get back to you when i am ready",
           'Okay, allow me to visit your offices first',
           'Okay for now can I use the free shipping order?', ''])(
    'refuses %j', (t) => expect(isUnqualifiedConfirm(t)).toBe(false));
});

describe('what counts as "I have paid"', () => {
  it.each(['I have paid', 'I have paid, any update?', 'Paid', 'Payment sent',
           'Nimelipa', 'Nimeshalipa', 'Nimelipia', 'Nishalipa', 'Nimefanya payment',
           'Nimemaliza kulipa', 'Nimetuma pesa'])(
    'fires on %j', (t) => expect(claimsPaid(t, null)).toBe(true));

  // Both of these were answered "Asante. We've got your payment
  // notification and our team is verifying it with M-Pesa now" — plus a
  // staff page. The second is a lead saying they will buy next month.
  it.each(['When is payment done?', 'Is payment done before or after delivery?',
           'can I try again at the end of the month once I get paid?',
           'I will pay once I get paid', 'How do I pay?'])(
    'stays quiet on %j', (t) => expect(claimsPaid(t, null)).toBe(false));

  it('trusts a pasted M-Pesa confirmation whatever its shape', () => {
    expect(claimsPaid('When is payment done? paid SFG5H8K2L9', 'SFG5H8K2L9')).toBe(true);
  });
});

describe('what counts as somewhere to send a parcel', () => {
  // Five characters rejected every one of these, and the customer was
  // asked the same question again on the next turn.
  it.each(['Voi', 'Juja', 'Meru', 'Embu', 'Ruai', 'Yaya', 'Nakuru', 'CBD',
           'Greenspan Estate, Donholm', 'Stanbank'])(
    'accepts %j', (t) => expect(looksLikeDestination(t)).toBe(true));

  it.each(['', 'Hi', 'ok', 'yes'])(
    'refuses %j', (t) => expect(looksLikeDestination(t)).toBe(false));
});


// Two live failures on the first two AI turns after the guard shipped.
describe('when the assistant cannot answer safely', () => {
  const aiSettings = {
    markup_pct: 10, promo_active: false, promo_type: 'waive_fee',
    promo_message: '', default_delivery_fee_kes: 300,
    welcome_media_urls: [], template_map: {},
    ai_enabled: true, ai_knowledge_base: 'Delivery takes 2 to 3 weeks.',
  };
  async function ai() {
    const waAi = await import('../../utils/waAi.js');
    // A queued `…Once` from an earlier suite that its branch never
    // consumed would be handed to us instead of our own stub.
    waAi.chatReply.mockReset();
    waAi.onboardingTurn.mockReset();
    waAi.aiConfigured.mockReturnValue(true);
    getWaSettings.mockResolvedValue(aiSettings);
    return waAi;
  }

  // Marion tripped the guard on "Heey", was told to wait for a
  // colleague, and then sent five more messages — including "there's a
  // pair of boots missing" — into a thread the assistant had been muted
  // on for two hours. A guard trip is our problem, not a request for a
  // person: page someone and stay available.
  it('pages a person but stays live when our own guard rejected the reply', async () => {
    const waAi = await ai();
    waAi.chatReply.mockResolvedValueOnce({ kind: 'handoff', text: null, guardTripped: true });
    const db = makeDb();
    await handleInbound(db, contact(), { id: 'm1', body: 'Heey' });

    expect(sendToContact.mock.calls[0][2].text).toMatch(/colleague/i);
    expect(notifyStaff).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ title: expect.stringMatching(/could not answer safely/i) }));
    // the assistant is NOT muted
    expect(db.query.mock.calls.some(([sql]) => sql.includes('human_takeover_at = NOW()'))).toBe(false);
  });

  it('still mutes itself when the customer actually asked for a person', async () => {
    const waAi = await ai();
    waAi.chatReply.mockResolvedValueOnce({ kind: 'handoff', text: null });
    const db = makeDb();
    await handleInbound(db, contact(), { id: 'm1', body: 'I want to speak to someone' });

    expect(db.query.mock.calls.some(([sql]) => sql.includes('human_takeover_at = NOW()'))).toBe(true);
    expect(notifyStaff).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ title: 'Customer needs a human' }));
  });

  // Diane asked where to dispatch her parcel, the Gemini call aborted at
  // 15s, the exception was swallowed and she got nothing for seven hours.
  it('pages a person when the model call fails outright', async () => {
    const waAi = await ai();
    waAi.chatReply.mockRejectedValueOnce(new Error('The operation was aborted due to timeout'));
    await handleInbound(makeDb(), contact(),
      { id: 'm1', body: 'Can it be dispatched to this address: Safari Park View estate, house 47' });

    expect(sendToContact).not.toHaveBeenCalled();
    expect(notifyStaff).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ title: expect.stringMatching(/failed to answer/i) }));
  });
});


// Marion had an order confirmed at KSh 17,746 and asked four times how to
// pay — "How do i make payment??", "Send me the till". Each time she was
// told the details would arrive shortly. Nothing was going to send them:
// the till goes out when the CUSTOMER accepts a quote or an operator
// presses the button, and hers had been confirmed by an operator hours
// earlier. Nine minutes later: "You haven't sent the details aki🤦‍♀️".
//
// A guardrail written to stop the assistant inventing payment
// instructions had also stopped it giving real ones. Answering this is
// money, so it now resolves in code, before the AI, off the order row.
describe('asking how to pay, with money actually owing', () => {
  it.each([
    'How do i make payment??', 'Send me the till', 'how do I pay?',
    'What is your till number', 'payment details please',
    'How can I make the payment', 'where do I send the money', 'Nitalipaje?',
  ])('recognises %j', (t) => expect(asksHowToPay(t)).toBe(true));

  it.each([
    'How long will the package take??', 'Please remind me the name of your business',
    'Okay', 'Can I pick up today?', 'I have paid', 'How are you',
  ])('leaves %j alone', (t) => expect(asksHowToPay(t)).toBe(false));

  const CONFIRMED = {
    id: 'o1', status: 'confirmed', quote_kes: '17746', tracking_code: null,
    delivery_fee_kes: null, delivery_fee_waived: false, delivery_fee_paid_at: null,
    delivery_fee_in_quote: true,
  };
  const ordersDb = (rows) => makeDb(async (sql) => {
    if (sql.includes("status IN ('confirmed'")) return { rows };
    if (sql.includes('INSERT INTO payments')) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });

  it('sends the real amount and the real till, without the AI', async () => {
    const waAi = await import('../../utils/waAi.js');
    waAi.chatReply.mockReset();
    await handleInbound(ordersDb([CONFIRMED]), contact(), { id: 'm', body: 'How do i make payment??' });

    const said = sendToContact.mock.calls[0][2].text;
    expect(said).toContain('17,746');
    expect(said).toMatch(/till/i);
    expect(said).not.toMatch(/will (arrive|be sent)|shortly|our team will send/i);
    expect(waAi.chatReply).not.toHaveBeenCalled();
  });

  it('opens the payment row so there is something to approve', async () => {
    const db = ordersDb([CONFIRMED]);
    await handleInbound(db, contact(), { id: 'm', body: 'Send me the till' });
    expect(db.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO payments'))).toBe(true);
  });

  // A quote they have not accepted is still their decision to make. Give
  // them the number they asked for; do not move the money state for them.
  it('gives the figure on an unaccepted quote but does not confirm it', async () => {
    const db = ordersDb([{ ...CONFIRMED, status: 'quoted' }]);
    await handleInbound(db, contact(), { id: 'm', body: 'Send me the till' });

    const said = sendToContact.mock.calls[0][2].text;
    expect(said).toContain('17,746');
    expect(said).toMatch(/YES/);
    expect(db.query.mock.calls.some(([sql]) => sql.includes("SET status = 'confirmed'"))).toBe(false);
  });

  // Two things owing at once would invite paying the wrong one.
  it('hands an ambiguous case to the assistant rather than guessing', async () => {
    const waAi = await import('../../utils/waAi.js');
    waAi.chatReply.mockReset();
    waAi.chatReply.mockResolvedValueOnce(says('answer'));
    waAi.aiConfigured.mockReturnValue(true);
    getWaSettings.mockResolvedValue({
      markup_pct: 10, promo_active: false, promo_type: 'waive_fee', promo_message: '',
      default_delivery_fee_kes: 300, welcome_media_urls: [], template_map: {},
      ai_enabled: true, ai_knowledge_base: 'kb',
    });
    await handleInbound(ordersDb([CONFIRMED, { ...CONFIRMED, id: 'o2' }]), contact(),
      { id: 'm', body: 'How do i make payment??' });
    expect(waAi.chatReply).toHaveBeenCalled();
  });

  it('says nothing about a till when nothing is owing', async () => {
    const waAi = await import('../../utils/waAi.js');
    waAi.chatReply.mockReset();
    waAi.chatReply.mockResolvedValueOnce(says('We take payment by M-Pesa once you have a quote.'));
    waAi.aiConfigured.mockReturnValue(true);
    await handleInbound(ordersDb([]), contact(), { id: 'm', body: 'how do I pay?' });
    expect(waAi.chatReply).toHaveBeenCalled();
  });
});

// ── Delivery method, after a price exists ────────────────────────────────────
// Brian's conversation, 28 August. He was quoted KSh 107,679 for
// collection, asked "Can I change to delivery?", was told "107,679 plus
// KSh 300" by the assistant, said yes, and paid 107,679. The KSh 300 was
// never charged and the parcel was routed to Hurlingham. Collection is
// free and delivery is not, so the method IS part of the price.
describe('saysDeliveryMethod', () => {
  it.each([
    ['Can I change to delivery?', 'delivery'],
    ['I want it delivered to Nakuru', 'delivery'],
    ['delivery', 'delivery'],
    ['Can I pick up my parcel instead of delivery?', 'collection'],
    ['CBD collection', 'collection'],
    ['I will collect it myself', 'collection'],
    ['collection', 'collection'],
  ])('reads %j as %s', (body, expected) => {
    expect(saysDeliveryMethod(body)).toBe(expected);
  });

  // The must-not-catch list. Each of these fired a re-quote page and a
  // "your total is changing" reply if the rule were any looser, and none
  // of them is a customer changing their mind.
  it.each([
    'How long does it take for items to be delivered?',
    'Where do I collect from?',
    'Can I come to your office?',
    'Hurlingham',
    'House Jembe 1',
    'Yes',
    'How do I pay?',
    'Is that the only amount I have to pay?',
    'I will send my cart later',
    '',
  ])('reads %j as neither', (body) => {
    expect(saysDeliveryMethod(body)).toBe(null);
  });
});

describe('switching delivery method after a quote', () => {
  function switchDb(orderRows) {
    return makeDb(async (sql) => {
      if (sql.includes("status IN ('quoted', 'confirmed')")) return { rows: orderRows };
      return { rows: [], rowCount: 1 };
    });
  }
  const collectionQuote = {
    id: 'o1', tracking_code: 'TRK-8839', quote_kes: '107679',
    delivery_method: 'collection', status: 'quoted',
  };

  it('pages staff to re-quote and promises a new quote, with no figure of its own', async () => {
    const db = switchDb([collectionQuote]);
    await handleInbound(db, contact(), { id: 'm', body: 'Can I change to delivery?' });

    expect(notifyStaff).toHaveBeenCalledWith(db, expect.objectContaining({
      title: 'Delivery method changed after quoting — re-quote needed',
    }));
    const reply = sendToContact.mock.calls[0][2].text;
    expect(reply).toMatch(/updating your quote/i);
    // The old total, the fee, any total at all: not this code's to state,
    // and stating one is exactly what went wrong.
    expect(reply).not.toMatch(/107,?679|300/);
  });

  it('records the choice so the re-quote defaults to it', async () => {
    const db = switchDb([collectionQuote]);
    await handleInbound(db, contact(), { id: 'm', body: 'Can I change to delivery?' });
    const update = db.query.mock.calls.find(([sql]) =>
      sql.includes('UPDATE wa_contacts') && sql.includes('delivery_preference'));
    expect(update[1]).toContain('delivery');
  });

  it('asks for the address when switching to delivery and we have none', async () => {
    const db = switchDb([collectionQuote]);
    await handleInbound(db, contact({ delivery_address: null }), { id: 'm', body: 'Can I change to delivery?' });
    expect(sendToContact.mock.calls[0][2].text).toMatch(/delivery address/i);
  });

  // Nothing is mis-priced until something is priced. Choosing a method
  // during signup is an answer to a question, not a change to a total.
  it('stays out of it when no quote exists', async () => {
    const db = switchDb([]);
    await handleInbound(db, contact(), { id: 'm', body: 'Can I change to delivery?' });
    expect(notifyStaff).not.toHaveBeenCalledWith(db, expect.objectContaining({
      title: 'Delivery method changed after quoting — re-quote needed',
    }));
  });

  it('stays out of it when the quote already used that method', async () => {
    const db = switchDb([{ ...collectionQuote, delivery_method: 'delivery' }]);
    await handleInbound(db, contact(), { id: 'm', body: 'Can I change to delivery?' });
    expect(notifyStaff).not.toHaveBeenCalledWith(db, expect.objectContaining({
      title: 'Delivery method changed after quoting — re-quote needed',
    }));
  });
});

describe('confirming a quote priced for the other delivery method', () => {
  it('refuses to bill the stale total and pages staff instead', async () => {
    const db = makeDb(async (sql) => {
      if (sql.includes("status = 'quoted'") && sql.startsWith('SELECT')) {
        return { rows: [{ id: 'o1', quote_kes: '107679', tracking_code: 'TRK-8839',
                          quote_expires_at: null, delivery_method: 'collection' }] };
      }
      if (sql.includes("status IN ('quoted', 'confirmed')")) return { rows: [] };
      return { rows: [], rowCount: 1 };
    });
    await handleInbound(db, contact({ delivery_preference: 'delivery' }), { id: 'm', body: 'yes' });

    expect(db.query.mock.calls.find(([sql]) => sql.includes("SET status = 'confirmed'"))).toBeUndefined();
    expect(db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO payments'))).toBeUndefined();
    expect(notifyStaff).toHaveBeenCalledWith(db, expect.objectContaining({
      title: 'Quote confirmed at the wrong delivery method — re-quote needed',
    }));
    expect(sendToContact.mock.calls[0][2].text).toMatch(/updating the quote/i);
  });

  it('confirms normally when the method still matches', async () => {
    const db = makeDb(async (sql) => {
      if (sql.includes("status = 'quoted'") && sql.startsWith('SELECT')) {
        return { rows: [{ id: 'o1', quote_kes: '14500', tracking_code: 'TRK-1',
                          quote_expires_at: null, delivery_method: 'delivery' }] };
      }
      return { rows: [], rowCount: 1 };
    });
    await handleInbound(db, contact({ delivery_preference: 'delivery' }), { id: 'm', body: 'yes' });
    expect(db.query.mock.calls.find(([sql]) => sql.includes("SET status = 'confirmed'"))).toBeTruthy();
  });
});

describe('a collector finishes signup on the scripted path', () => {
  it('takes "I will collect it myself" as the destination and issues the code', async () => {
    const db = makeDb(async (sql) => {
      if (sql.includes('nextval')) return { rows: [{ n: '1050' }] };
      return { rows: [], rowCount: 1 };
    });
    await handleInbound(db, contact({ state: 'awaiting_address', full_name: 'Jane Doe', customer_code: null }),
      { id: 'm', body: 'I will collect it myself' });

    const update = db.query.mock.calls.find(([sql]) => sql.includes('UPDATE wa_contacts'));
    // The method decides the fee; the sentence is not an address and
    // storing it as one told the ops screens a rider had somewhere to go.
    expect(update[0]).toContain('delivery_preference');
    expect(update[0]).not.toContain('delivery_address');
    expect(update[1]).toContain('active');
    const said = sendToContact.mock.calls.map(([, , o]) => o.text || '').join(' ');
    expect(said).toMatch(/customer code/i);
    expect(said).toMatch(/no delivery fee/i);
  });
});

describe('an explicit request for a person', () => {
  const aiSettings = {
    markup_pct: 10, promo_active: false, promo_type: 'waive_fee',
    promo_message: '', default_delivery_fee_kes: 300,
    welcome_media_urls: [], template_map: {},
    ai_enabled: true, ai_knowledge_base: 'kb', ai_resume_after_minutes: 120,
  };
  async function ai() {
    const waAi = await import('../../utils/waAi.js');
    waAi.chatReply.mockReset();
    waAi.onboardingTurn.mockReset();
    waAi.aiConfigured.mockReturnValue(true);
    getWaSettings.mockResolvedValue(aiSettings);
    return waAi;
  }

  // Must catch. The first of these is what Diane Mworia actually sent at
  // 10:15 on 4 September, into a thread the 09:31 handoff had muted the
  // assistant on — it reached nobody at all.
  it.each([
    'Requesting human support please',
    'Talk to a person',
    'Can I talk to a human?',
    'I want to speak to someone',
    'please connect me with an agent',
    'I need to talk to a real person about my order',
    'Naweza ongea na mtu?',
    'nataka kuongea na mtu',
    'agent',
    'customer care',
  ])('escalates "%s"', (msg) => {
    expect(wantsHuman(msg)).toBe(true);
  });

  // Must NOT catch. A guard that fires wrongly here hands the customers
  // closest to paying to a person and mutes the assistant on them.
  it.each([
    'someone told me about you guys',
    "I'll talk to my husband first",
    'Let me talk to my agent in Dubai',
    'Can I speak to you about the sizes?',
    'I sent someone the link already',
    'Is the leather real?',
    'yes',
    'I have paid',
  ])('leaves "%s" alone', (msg) => {
    expect(wantsHuman(msg)).toBe(false);
  });

  it('pages staff without consulting the assistant', async () => {
    const waAi = await ai();
    await handleInbound(makeDb(async () => ({ rows: [] })), contact(),
      { id: 'm1', body: 'Requesting human support please' });

    expect(waAi.chatReply).not.toHaveBeenCalled();
    expect(notifyStaff).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      title: expect.stringMatching(/needs a human/i),
    }));
    expect(sendToContact.mock.calls[0][2].text).toMatch(/team will reply/i);
  });

  // The whole point. The AI branch is skipped while a human holds the
  // thread, which is exactly when a customer asks again — and until this
  // branch existed, asking again did nothing whatsoever.
  it('pages again while the assistant is muted by an earlier handoff', async () => {
    await ai();
    const db = makeDb(async (sql) => {
      // aiOnHold: the last message was 10 minutes ago, well inside the
      // 120-minute resume window, so the assistant stays muted.
      if (sql.includes('MAX(created_at)')) {
        return { rows: [{ at: new Date(Date.now() - 10 * 60_000).toISOString() }] };
      }
      return { rows: [], rowCount: 0 };
    });
    await handleInbound(db, contact({ human_takeover_at: new Date().toISOString() }),
      { id: 'm2', body: 'Requesting human support please' });

    expect(notifyStaff).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      title: expect.stringMatching(/asked for a person again/i),
      detail: expect.stringContaining('waiting on a person'),
    }));
    expect(pushToStaff).toHaveBeenCalledWith('wa_human_requested', expect.objectContaining({
      contact_id: 'c1',
    }));
    // Takeover is already set; it must not be re-stamped, and the
    // acknowledgement must not promise a second time within the hour.
    expect(db.query.mock.calls.some(([sql]) => sql.includes('human_takeover_at = NOW()'))).toBe(false);
  });

  it('does not repeat the acknowledgement it already sent this hour', async () => {
    await ai();
    const db = makeDb(async (sql) => {
      if (sql.includes('MAX(created_at)')) {
        return { rows: [{ at: new Date(Date.now() - 10 * 60_000).toISOString() }] };
      }
      // sentRecently: we said "get a colleague for you" already.
      if (sql.includes("direction = 'out'")) return { rows: [{ '?column?': 1 }] };
      return { rows: [], rowCount: 0 };
    });
    await handleInbound(db, contact({ human_takeover_at: new Date().toISOString() }),
      { id: 'm3', body: 'Talk to a person' });

    expect(sendToContact).not.toHaveBeenCalled();
    expect(notifyStaff).toHaveBeenCalled(); // but a person is still paged
  });

  // Money and state resolve first where they run: this message pages a
  // person either way, and only the payment branch stamps the reference.
  it('lets a payment claim keep its own branch', async () => {
    const waAi = await ai();
    await handleInbound(makeDb(async () => ({ rows: [] })), contact(),
      { id: 'm4', body: 'I have paid, can I speak to someone?' });

    expect(notifyStaff).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      title: expect.stringMatching(/payment claimed/i),
    }));
    expect(waAi.chatReply).not.toHaveBeenCalled();
  });
});
