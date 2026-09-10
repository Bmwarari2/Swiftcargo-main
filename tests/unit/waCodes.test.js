import { describe, it, expect, vi } from 'vitest';
import {
  nextCustomerCode,
  nextTrackingCode,
  extractTrackingCode,
  extractOrderCode,
  extractCustomerCode,
} from '../../utils/waCodes.js';

describe('code minting', () => {
  it('prefixes the customer sequence value', async () => {
    const db = { query: vi.fn(async () => ({ rows: [{ n: '1042' }] })) };
    expect(await nextCustomerCode(db)).toBe('TC-1042');
    expect(db.query.mock.calls[0][0]).toContain('wa_customer_code_seq');
  });

  it('prefixes the tracking sequence value', async () => {
    const db = { query: vi.fn(async () => ({ rows: [{ n: '8821' }] })) };
    expect(await nextTrackingCode(db)).toBe('TRK-8821');
    expect(db.query.mock.calls[0][0]).toContain('wa_tracking_code_seq');
  });
});

describe('extractTrackingCode', () => {
  it.each([
    ['TRK-8821', 'TRK-8821'],
    ['trk 8821', 'TRK-8821'],
    ['Trk8821', 'TRK-8821'],
    ['where is TRK-8821 please', 'TRK-8821'],
    ['my code is trk-990011', 'TRK-990011'],
  ])('extracts from %j', (input, expected) => {
    expect(extractTrackingCode(input)).toBe(expected);
  });

  it.each([
    ['hello there'],
    ['TC-1042'],           // customer code, not tracking
    ['TRK-'],              // no digits
    ['track my parcel'],
    [null],
    [undefined],
  ])('returns null for %j', (input) => {
    expect(extractTrackingCode(input)).toBe(null);
  });
});

describe('extractOrderCode', () => {
  // The order number goes out on the quote and on the payment prompt,
  // long before a parcel exists, so it is the code a customer types back
  // at us — in whatever shape they type it.
  it.each([
    ['ORD-3001', 'ORD-3001'],
    ['ord 3001', 'ORD-3001'],
    ['Ord3001', 'ORD-3001'],
    ['any news on ord-3001?', 'ORD-3001'],
  ])('extracts from %j', (input, expected) => {
    expect(extractOrderCode(input)).toBe(expected);
  });

  it.each([
    ['TRK-8821'],          // a parcel, not an order
    ['TC-1042'],           // a customer, not an order
    ['ORD-'],              // no digits
    ['I ordered this last week'],
    [null],
  ])('returns null for %j', (input) => {
    expect(extractOrderCode(input)).toBe(null);
  });

  // The three code types must not answer to each other: telling a
  // customer about the wrong order is worse than not recognising a code.
  it('does not cross-match the other two code types', () => {
    expect(extractTrackingCode('ORD-3001')).toBe(null);
    expect(extractCustomerCode('ORD-3001')).toBe(null);
  });
});

describe('extractCustomerCode', () => {
  it('extracts and normalizes', () => {
    expect(extractCustomerCode('tc 1042')).toBe('TC-1042');
    expect(extractCustomerCode('TC-1042')).toBe('TC-1042');
  });
  it('rejects tracking codes and noise', () => {
    expect(extractCustomerCode('TRK-8821')).toBe(null);
    expect(extractCustomerCode('nothing here')).toBe(null);
  });
});
