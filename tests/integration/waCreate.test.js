import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import app from '../../server.js';
import { initializeDatabase, getPool } from '../../database/init.js';

// The two operator-driven creation paths: adding a customer who arrived
// somewhere other than WhatsApp, and logging an order that is already
// partway through the pipeline.
//
// Written after both broke in production on the same afternoon. The order
// route referenced pushToStaff without importing it, which is invisible to
// every unit test in the suite because the crash only happens once the
// handler actually runs — and it ran far enough to write the order and burn
// a tracking code before throwing, so the operator was told "failed" about
// an order that existed. Exercising the real routes against a real database
// is the only thing that catches that class of break.
//
// Gated on TEST_DATABASE_URL, like the other integration suites.

const SKIP = !process.env.TEST_DATABASE_URL;

const userIds = [];
const contactPhones = [];
let token;

async function seedOperator() {
  const id = randomUUID();
  const email = `vitest-wa-${id}@test.thapsus.uk`;
  const password = 'PassPhrase!23';
  await getPool().query(
    `INSERT INTO users (id, email, password_hash, name, phone, role, warehouse_id,
                        language_pref, referral_code, is_active, email_verified_at)
     VALUES ($1, $2, $3, 'Vitest Ops', '+254700000000', 'admin', $4, 'en', $5, true, NOW())`,
    [id, email, bcrypt.hashSync(password, 10), `TC-VT-${id.slice(0, 6)}`,
     `REFWA${id.slice(0, 8).toUpperCase()}`]
  );
  userIds.push(id);
  const r = await request(app).post('/api/auth/login').send({ email, password });
  expect(r.status).toBe(200);
  return r.body.token;
}

/** A Kenyan mobile number that won't collide with a seeded or real row. */
function freshPhone() {
  const n = `2547${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  contactPhones.push(n);
  return n;
}

async function addContact(body) {
  return request(app)
    .post('/api/wa/contacts')
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

beforeAll(async () => {
  if (SKIP) return;
  await initializeDatabase();
  token = await seedOperator();
});

afterAll(async () => {
  if (SKIP) return;
  const pool = getPool();
  if (contactPhones.length) {
    // Orders and events cascade from the contact.
    await pool.query(
      `DELETE FROM wa_order_events WHERE order_id IN
         (SELECT o.id FROM wa_orders o JOIN wa_contacts c ON c.id = o.contact_id
           WHERE c.phone = ANY($1::text[]))`, [contactPhones]);
    await pool.query(
      `DELETE FROM wa_orders WHERE contact_id IN
         (SELECT id FROM wa_contacts WHERE phone = ANY($1::text[]))`, [contactPhones]);
    await pool.query(`DELETE FROM wa_contacts WHERE phone = ANY($1::text[])`, [contactPhones]);
  }
  if (userIds.length) {
    await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [userIds]);
  }
  await pool.end();
});

describe.skipIf(SKIP)('POST /api/wa/contacts — operator adds a customer', () => {
  it('issues a customer code off the name alone', async () => {
    const r = await addContact({ phone: freshPhone(), full_name: 'Faith Wanjiru', source: 'Instagram' });
    expect(r.status).toBe(201);
    expect(r.body.contact.customer_code).toMatch(/^TC-\d+$/);
    // Still short an address, so the assistant knows what to ask for if
    // they message in.
    expect(r.body.contact.state).toBe('awaiting_address');
  });

  it('marks a fully-specified customer active', async () => {
    const phone = freshPhone();
    const r = await addContact({
      phone,
      full_name: 'Grace Achieng',
      delivery_address: 'Crest Apartments, Thindigua, Kiambu',
    });
    expect(r.status).toBe(201);
    expect(r.body.contact.customer_code).toMatch(/^TC-\d+$/);
    expect(r.body.contact.state).toBe('active');
  });

  it('normalizes a Kenyan number typed in local form', async () => {
    const phone = freshPhone();
    const local = `0${phone.slice(3)}`;
    const r = await addContact({ phone: local, full_name: 'Local Format' });
    expect(r.status).toBe(201);
    expect(r.body.contact.phone).toBe(phone);
  });

  it('refuses a foreign number with no country code', async () => {
    // Bare digits are ambiguous — the same string can be a real foreign
    // number or a Kenyan one typed wrong, and the two want opposite
    // treatment. Ask rather than guess.
    const r = await addContact({ phone: '3125550142', full_name: 'No Country Code' });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/country code/i);
  });

  it('accepts a foreign number that carries its country code', async () => {
    const r = await addContact({ phone: '+44 7424 531484', full_name: 'UK Sender' });
    expect(r.status).toBe(201);
    expect(r.body.contact.phone).toBe('447424531484');
    contactPhones.push('447424531484');
  });

  it('accepts a short international number', async () => {
    // Maldives: +960 plus seven digits. Customers are not all on
    // twelve-digit Kenyan numbers, and the stored form stays bare digits
    // because toE164() puts the + back on the way out.
    const r = await addContact({ phone: '+960 721 8089', full_name: 'Maldives Customer' });
    expect(r.status).toBe(201);
    expect(r.body.contact.phone).toBe('9607218089');
    contactPhones.push('9607218089');
  });

  // Nothing asks for an M-Pesa number any more, but an operator can still
  // type one in for an STK push, and it still has to be a Kenyan number.
  it('rejects an M-Pesa number that is not Kenyan', async () => {
    const r = await addContact({ phone: freshPhone(), full_name: 'Bad Till', mpesa_number: '+44 7424 531484' });
    expect(r.status).toBe(400);
  });
});

describe.skipIf(SKIP)('PUT /api/wa/contacts/:id — operator corrects a contact', () => {
  const put = (id, body) => request(app)
    .put(`/api/wa/contacts/${id}`)
    .set('Authorization', `Bearer ${token}`)
    .send(body);

  it('corrects a phone number, and codes them once a name lands', async () => {
    // A contact with no name gets no code on the way in...
    const created = await addContact({ phone: freshPhone() });
    expect(created.status).toBe(201);
    expect(created.body.contact.customer_code).toBeNull();

    // ...and picks one up when the operator fills in who they are.
    const corrected = freshPhone();
    const r = await put(created.body.contact.id, { full_name: 'Named Later', phone: corrected });
    expect(r.status).toBe(200);
    expect(r.body.contact.phone).toBe(corrected);
    expect(r.body.contact.customer_code).toMatch(/^TC-\d+$/);
  });

  it('refuses a correction to an ambiguous number, leaving the old one', async () => {
    const created = await addContact({ phone: freshPhone(), full_name: 'Keeps Their Number' });
    const r = await put(created.body.contact.id, { phone: '3125550142' });
    expect(r.status).toBe(400);
    const { rows } = await getPool().query(
      `SELECT phone FROM wa_contacts WHERE id = $1`, [created.body.contact.id]);
    expect(rows[0].phone).toBe(created.body.contact.phone);
  });

  it('409s rather than colliding with another contact’s number', async () => {
    const a = await addContact({ phone: freshPhone(), full_name: 'First' });
    const b = await addContact({ phone: freshPhone(), full_name: 'Second' });
    const r = await put(b.body.contact.id, { phone: a.body.contact.phone });
    expect(r.status).toBe(409);
  });
});

describe.skipIf(SKIP)('POST /api/wa/orders — operator logs a mid-flight order', () => {
  let contactId;

  beforeAll(async () => {
    const r = await addContact({ phone: freshPhone(), full_name: 'Pipeline Tester' });
    contactId = r.body.contact.id;
  });

  const post = (body) => request(app)
    .post('/api/wa/orders')
    .set('Authorization', `Bearer ${token}`)
    .send({ contact_id: contactId, ...body });

  it('creates a quoting order with no amount', async () => {
    const r = await post({ product_links: ['https://example.com/a'], product_note: 'SHEIN' });
    expect(r.status).toBe(201);
    expect(r.body.order.status).toBe('quoting');
    expect(r.body.order.tracking_code).toBeNull();
    // ...but never without a number. Before migration 0021 an order with
    // no tracking code had no name at all, and the quote that went out
    // called it "#" plus eight characters of its uuid.
    expect(r.body.order.order_code).toMatch(/^ORD-\d+$/);
  });

  it('gives every order its own number, whatever stage it starts at', async () => {
    const a = await post({ product_note: 'first' });
    const b = await post({ status: 'purchased', quote_kes: 4200, product_note: 'second' });
    expect(a.body.order.order_code).toMatch(/^ORD-\d+$/);
    expect(b.body.order.order_code).toMatch(/^ORD-\d+$/);
    expect(a.body.order.order_code).not.toBe(b.body.order.order_code);
    // The two codes name different things: one order, one parcel.
    expect(b.body.order.tracking_code).toMatch(/^TRK-\d+$/);
    expect(b.body.order.tracking_code).not.toBe(b.body.order.order_code);
  });

  it('finds an order by the number the customer was given', async () => {
    const created = await post({ product_note: 'searchable' });
    const code = created.body.order.order_code;
    // Typed back the way a customer types it, lower case and spaced.
    const r = await request(app)
      .get(`/api/wa/orders?q=${encodeURIComponent(code.toLowerCase().replace('-', ' '))}&limit=100`)
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.orders.map((o) => o.id)).toContain(created.body.order.id);
  });

  it('resolves an order number through the scanner endpoint', async () => {
    // An operator holding a quote the customer quoted back at them has an
    // order number and no parcel.
    const created = await post({ product_note: 'scannable' });
    const r = await request(app)
      .get(`/api/wa/orders/scan/${created.body.order.order_code}`)
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.order.id).toBe(created.body.order.id);
  });

  it('creates an order dropped straight into a later stage, with a tracking code', async () => {
    const r = await post({ status: 'purchased', quote_kes: 26866, product_note: 'SHEIN' });
    expect(r.status).toBe(201);
    expect(r.body.order.status).toBe('purchased');
    expect(r.body.order.tracking_code).toMatch(/^TRK-\d+$/);
    expect(Number(r.body.order.quote_kes)).toBe(26866);
    // Earlier stages are stamped too, so the timeline reads as a history.
    expect(r.body.order.paid_at).toBeTruthy();
    expect(r.body.order.purchased_at).toBeTruthy();

    const { rows } = await getPool().query(
      `SELECT to_status FROM wa_order_events WHERE order_id = $1`, [r.body.order.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].to_status).toBe('purchased');
  });

  it('refuses a priced stage with no amount, and writes nothing', async () => {
    const before = await getPool().query(
      `SELECT COUNT(*)::int AS n FROM wa_orders WHERE contact_id = $1`, [contactId]);
    const r = await post({ status: 'confirmed' });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/quote_kes/);
    const after = await getPool().query(
      `SELECT COUNT(*)::int AS n FROM wa_orders WHERE contact_id = $1`, [contactId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('rejects an unknown stage', async () => {
    const r = await post({ status: 'teleported', quote_kes: 100 });
    expect(r.status).toBe(400);
  });

  it('404s on a contact that does not exist', async () => {
    const r = await request(app)
      .post('/api/wa/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ contact_id: randomUUID() });
    expect(r.status).toBe(404);
  });
});

describe.skipIf(SKIP)('supplier order references', () => {
  let contactId;
  const ref = `GSHMU${Math.floor(Math.random() * 1e9)}`;

  beforeAll(async () => {
    const r = await addContact({ phone: freshPhone(), full_name: 'Batch Buyer' });
    contactId = r.body.contact.id;
  });

  const newOrder = async (note) => {
    const r = await request(app)
      .post('/api/wa/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ contact_id: contactId, product_note: note });
    expect(r.status).toBe(201);
    return r.body.order;
  };

  const tag = (ids, supplier_ref) => request(app)
    .post('/api/wa/orders/supplier-ref')
    .set('Authorization', `Bearer ${token}`)
    .send({ order_ids: ids, supplier_ref });

  const search = (q) => request(app)
    .get(`/api/wa/orders?q=${encodeURIComponent(q)}&limit=100`)
    .set('Authorization', `Bearer ${token}`);

  it('tags several orders with one reference and finds them all again', async () => {
    // The point of the feature: one supplier purchase, several of our
    // parcels, and later a question about the whole batch.
    const a = await newOrder('shoes');
    const b = await newOrder('jacket');
    const c = await newOrder('bag');

    const r = await tag([a.id, b.id, c.id], ref);
    expect(r.status).toBe(200);
    expect(r.body.updated).toBe(3);

    const found = await search(ref);
    expect(found.status).toBe(200);
    expect(found.body.orders.map((o) => o.id).sort()).toEqual([a.id, b.id, c.id].sort());
    expect(found.body.orders.every((o) => o.supplier_ref === ref)).toBe(true);
  });

  it('finds the batch however the reference is capitalised', async () => {
    const found = await search(ref.toLowerCase());
    expect(found.body.orders.length).toBe(3);
  });

  it('records the tagging in each order history', async () => {
    const a = await newOrder('single');
    await tag([a.id], ref);
    const detail = await request(app)
      .get(`/api/wa/orders/${a.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(detail.body.events.some((e) => (e.note || '').includes(ref))).toBe(true);
  });

  it('clears the reference when given an empty one', async () => {
    const a = await newOrder('to be untagged');
    await tag([a.id], ref);
    const cleared = await tag([a.id], '');
    expect(cleared.status).toBe(200);
    expect(cleared.body.supplier_ref).toBeNull();
    const detail = await request(app)
      .get(`/api/wa/orders/${a.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(detail.body.order.supplier_ref).toBeNull();
  });

  it('accepts a reference at creation time', async () => {
    const r = await request(app)
      .post('/api/wa/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ contact_id: contactId, status: 'purchased', quote_kes: 4000, supplier_ref: ref });
    expect(r.status).toBe(201);
    expect(r.body.order.supplier_ref).toBe(ref);
  });

  it('refuses a reference with characters an order number never has', async () => {
    const a = await newOrder('bad ref');
    const r = await tag([a.id], 'drop table; --');
    expect(r.status).toBe(400);
  });

  it('refuses an empty selection', async () => {
    expect((await tag([], ref)).status).toBe(400);
  });
});
