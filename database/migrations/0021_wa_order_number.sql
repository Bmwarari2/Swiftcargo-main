-- 0021_wa_order_number.sql — every order gets a number the day it exists.
--
-- ⚠ DEPLOY ORDER: APPLY THIS BEFORE THE CODE. Additive, but not
-- order-free: the pipeline search and the scanner in routes/waOrders.js
-- name o.order_code in their WHERE clauses, and utils/waNudges.js and
-- utils/waStateMachine.js name it in their SELECT lists — none of that
-- runs against a database without the column. Same shape as 0007, same
-- reason. The other direction is harmless: the column default means
-- code that has never heard of order_code still creates orders that
-- have one.
--
-- An order has had no name of its own until payment. tracking_code is
-- minted when the money lands (utils/markPaymentPaid.js), so everything
-- before that — the whole quoting and confirming half of the pipeline,
-- which is where the customer is actually deciding — fell back to
-- `#` plus the first eight characters of a uuid. That string went out on
-- real quotes and real payment prompts as the order_ref template
-- variable: "#a3f9c2b1" is not something a customer reads back to us
-- over WhatsApp, and it is not something an operator can search for
-- either. It is also not stable in meaning — the same order becomes
-- TRK-8821 the moment it is paid, so the customer is handed two
-- different names for one order and neither of them was ever explained.
--
-- ORD-3001 is minted at INSERT and never changes. tracking_code keeps
-- its job unchanged: it is the *parcel's* code, it appears on labels and
-- it is what the public tracking endpoint answers to. The order number
-- is the conversation's handle on the order and deliberately does NOT
-- resolve on that public endpoint — order codes exist from the moment an
-- order is created, and codes here are sequential and guessable by
-- design (see utils/waCodes.js), so answering them publicly would expose
-- the pipeline of orders nobody has paid for yet.
--
-- The 3000 band keeps the three code types apart when they are read
-- aloud or typed back: customer codes start at TC-1042 and tracking
-- codes at TRK-8821, so a bare "1042" in a message is not ambiguous
-- between an order and a customer.

CREATE SEQUENCE IF NOT EXISTS public.wa_order_code_seq START WITH 3001;

ALTER TABLE public.wa_orders ADD COLUMN IF NOT EXISTS order_code text;

-- Back-fill oldest first, so the numbers on the orders that already
-- exist read as the history they are rather than as whatever order the
-- rewrite happened to touch rows in. row_number() rather than nextval()
-- for exactly that reason; the sequence is then moved past the block.
DO $$
DECLARE next_code bigint;
BEGIN
    WITH numbered AS (
        SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn
          FROM public.wa_orders
         WHERE order_code IS NULL
    )
    UPDATE public.wa_orders o
       SET order_code = 'ORD-' || (3000 + numbered.rn)
      FROM numbered
     WHERE o.id = numbered.id;

    SELECT COALESCE(MAX((substring(order_code FROM '^ORD-(\d+)$'))::bigint), 3000) + 1
      INTO next_code
      FROM public.wa_orders;
    -- Only ever forwards. Re-running this file after rows have been
    -- deleted would otherwise rewind the sequence onto numbers those
    -- orders were given, and an order number a customer has been quoted
    -- must not come back as somebody else's.
    -- is_called = false: the next nextval() returns next_code itself.
    IF next_code > (SELECT last_value FROM public.wa_order_code_seq) THEN
        PERFORM setval('public.wa_order_code_seq', next_code, false);
    END IF;
END $$;

-- The default is what makes "every order has a number" true rather than
-- merely intended. The one INSERT site today is POST /api/wa/orders, but
-- a rule enforced only at the one call site you remembered is the same
-- rule that let a customer's handoff request run no code at all (see
-- wantsHuman in utils/waStateMachine.js). An import script, a hand-run
-- INSERT and next year's second creation path all get a number without
-- knowing they needed one.
ALTER TABLE public.wa_orders
    ALTER COLUMN order_code SET DEFAULT ('ORD-' || nextval('public.wa_order_code_seq'));
ALTER TABLE public.wa_orders
    ALTER COLUMN order_code SET NOT NULL;

-- The backstop against a hand-inserted duplicate, same as
-- wa_orders_tracking_code_key.
CREATE UNIQUE INDEX IF NOT EXISTS wa_orders_order_code_key
    ON public.wa_orders (order_code);
