// Seed script — runs via `npx prisma db seed`. Goals:
//   1. Reproducible: faker.seed() pins random output across runs
//   2. Idempotent: wipes existing rows so re-seeding works
//   3. Demo-ready: 5 named customers with deterministic transaction patterns
//      so we can reliably demo cascade scenarios in the Day 4 UI
//   4. Volume-ish: 195 random customers + ~1500 random transactions to give
//      segments a non-trivial population once Day 2's evaluator runs
//
// Note: dynamic segments are seeded with NO members. The evaluator (Day 2)
// computes initial membership from the rules. The only segment with members
// from the seed is the static March Campaign — because static segments are
// defined by their materialized rows, not by a rule.

import { Prisma, PrismaClient, SegmentType } from '@prisma/client';
import { faker } from '@faker-js/faker';
import type { SegmentRule } from '@drift/shared';

const prisma = new PrismaClient();

const NOW = new Date();
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

// Prisma's Json input type doesn't structurally accept our SegmentRule union
// (recursive interfaces aren't recognized as plain JSON-shaped). The cast is
// safe: SegmentRule only contains string/number/array — all valid JSON.
const toJsonRule = (rule: SegmentRule): Prisma.InputJsonValue =>
  rule as unknown as Prisma.InputJsonValue;

async function main() {
  console.log('▶ Wiping existing rows...');
  // Delete in dependency order to avoid FK violations.
  await prisma.segmentMember.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.segment.deleteMany();
  await prisma.customer.deleteMany();

  faker.seed(42);

  // ─── 1. Named scenario customers ────────────────────────────────────────
  // These five are the fixtures we'll use to demo cascades reliably. Their
  // transaction shapes (next block) put them in known segment states.
  console.log('▶ Inserting 5 named scenario customers...');
  const nino = await prisma.customer.create({
    data: { name: 'Nino Beridze', email: 'nino@drift.test', profile: { tier: 'gold' } },
  });
  const lasha = await prisma.customer.create({
    data: { name: 'Lasha Kapanadze', email: 'lasha@drift.test', profile: { tier: 'silver' } },
  });
  const tamar = await prisma.customer.create({
    data: { name: 'Tamar Lomidze', email: 'tamar@drift.test', profile: { tier: 'bronze' } },
  });
  const giorgi = await prisma.customer.create({
    data: { name: 'Giorgi Tsereteli', email: 'giorgi@drift.test', profile: { tier: 'gold' } },
  });
  const mari = await prisma.customer.create({
    data: { name: 'Mari Kvaratskhelia', email: 'mari@drift.test', profile: { tier: 'bronze' } },
  });

  // ─── 2. Random customers ────────────────────────────────────────────────
  console.log('▶ Inserting 195 random customers...');
  await prisma.customer.createMany({
    data: Array.from({ length: 195 }, (_, i) => ({
      name: faker.person.fullName(),
      // Prefix index to guarantee uniqueness even if faker collides.
      email: `seed-${i}-${faker.internet.username()}@drift.test`.toLowerCase(),
      profile: {
        country: faker.helpers.arrayElement(['GE', 'US', 'DE', 'TR']),
        tier: faker.helpers.arrayElement(['bronze', 'silver', 'gold']),
        joinedYear: faker.number.int({ min: 2020, max: 2026 }),
      },
    })),
  });
  // Pull them back so we have IDs for the transaction loop and the static segment.
  const randomCustomers = await prisma.customer.findMany({
    where: { email: { startsWith: 'seed-' } },
    select: { id: true },
  });

  // ─── 3. Named-customer transactions (deterministic) ─────────────────────
  console.log('▶ Inserting deterministic transactions for named customers...');

  // Nino — Active VIP. Last 60d sum = 8000, last tx 28d ago.
  // Day 4 demo: advance time 3 days → ages out of Active Buyers → cascade
  // removes her from Active VIPs.
  await prisma.transaction.createMany({
    data: [
      { customerId: nino.id, amount: new Prisma.Decimal('3000.00'), occurredAt: daysAgo(28) },
      { customerId: nino.id, amount: new Prisma.Decimal('2500.00'), occurredAt: daysAgo(40) },
      { customerId: nino.id, amount: new Prisma.Decimal('2500.00'), occurredAt: daysAgo(55) },
    ],
  });

  // Lasha — VIP but not Active (last tx 35d ago, 60d sum = 5500).
  // Day 4 demo: add a small tx today → joins Active Buyers → cascade adds him
  // to Active VIPs.
  await prisma.transaction.createMany({
    data: [
      { customerId: lasha.id, amount: new Prisma.Decimal('3000.00'), occurredAt: daysAgo(35) },
      { customerId: lasha.id, amount: new Prisma.Decimal('2500.00'), occurredAt: daysAgo(50) },
    ],
  });

  // Tamar — Risk Group. Was active long ago; nothing in the last 90 days.
  await prisma.transaction.createMany({
    data: [
      { customerId: tamar.id, amount: new Prisma.Decimal('150.00'), occurredAt: daysAgo(100) },
      { customerId: tamar.id, amount: new Prisma.Decimal('200.00'), occurredAt: daysAgo(120) },
    ],
  });

  // Giorgi — always Active and always VIP (high-volume regular).
  // Sanity fixture: should appear in Active Buyers, VIP, and Active VIPs.
  await prisma.transaction.createMany({
    data: [
      { customerId: giorgi.id, amount: new Prisma.Decimal('1000.00'), occurredAt: daysAgo(2) },
      { customerId: giorgi.id, amount: new Prisma.Decimal('800.00'), occurredAt: daysAgo(10) },
      { customerId: giorgi.id, amount: new Prisma.Decimal('1500.00'), occurredAt: daysAgo(20) },
      { customerId: giorgi.id, amount: new Prisma.Decimal('2000.00'), occurredAt: daysAgo(35) },
      { customerId: giorgi.id, amount: new Prisma.Decimal('1200.00'), occurredAt: daysAgo(50) },
    ],
  });

  // Mari — no transactions. Sanity fixture: should appear in zero segments.
  void mari;

  // ─── 4. Random transactions ─────────────────────────────────────────────
  console.log('▶ Inserting ~1500 random transactions for the 195 random customers...');
  const randomTxs: Prisma.TransactionCreateManyInput[] = [];
  for (const c of randomCustomers) {
    const txCount = faker.number.int({ min: 0, max: 15 });
    for (let i = 0; i < txCount; i++) {
      randomTxs.push({
        customerId: c.id,
        amount: new Prisma.Decimal(
          faker.number.float({ min: 5, max: 1500, fractionDigits: 2 }).toFixed(2),
        ),
        occurredAt: daysAgo(faker.number.int({ min: 0, max: 90 })),
      });
    }
  }
  await prisma.transaction.createMany({ data: randomTxs });

  // ─── 5. Segments ────────────────────────────────────────────────────────
  // Insert leaf segments first because Active VIPs' rule references their IDs.
  console.log('▶ Inserting segments...');

  const activeBuyersRule: SegmentRule = {
    kind: 'compare',
    metric: 'tx_count_30d',
    op: '>=',
    value: 1,
  };
  const activeBuyers = await prisma.segment.create({
    data: {
      name: 'Active Buyers',
      description: 'Customers with at least one transaction in the last 30 days.',
      type: SegmentType.DYNAMIC,
      rule: toJsonRule(activeBuyersRule),
    },
  });

  const vipRule: SegmentRule = {
    kind: 'compare',
    metric: 'sum_amount_60d',
    op: '>',
    value: 5000,
  };
  const vip = await prisma.segment.create({
    data: {
      name: 'VIP',
      description: 'Customers whose 60-day spend exceeds 5,000 GEL.',
      type: SegmentType.DYNAMIC,
      rule: toJsonRule(vipRule),
    },
  });

  // Risk Group: no tx in last 90 days AND has at least one tx ever
  // (i.e., "previously active, now silent").
  const riskGroupRule: SegmentRule = {
    kind: 'and',
    children: [
      { kind: 'compare', metric: 'last_tx_age_days', op: '>', value: 90 },
      { kind: 'compare', metric: 'tx_count_total', op: '>=', value: 1 },
    ],
  };
  await prisma.segment.create({
    data: {
      name: 'Risk Group',
      description: 'Customers with no transaction in 90 days but were previously active.',
      type: SegmentType.DYNAMIC,
      rule: toJsonRule(riskGroupRule),
    },
  });

  // Active VIPs — composite. References the IDs of the two leaf segments above.
  // The Day 2 evaluator extracts these `in_segment` references to build the
  // SegmentDependency graph automatically — no manual edge management.
  const activeVipsRule: SegmentRule = {
    kind: 'and',
    children: [
      { kind: 'in_segment', segmentId: activeBuyers.id },
      { kind: 'in_segment', segmentId: vip.id },
    ],
  };
  await prisma.segment.create({
    data: {
      name: 'Active VIPs',
      description: 'Customers in both Active Buyers and VIP — demonstrates cascading.',
      type: SegmentType.DYNAMIC,
      rule: toJsonRule(activeVipsRule),
    },
  });

  // March Campaign — static. Pre-populated with 50 members at seed time.
  //
  // The rule below is what "manual refresh" re-evaluates against. It picks
  // customers with at least 10 lifetime transactions — roughly a third of
  // the random population qualifies. Clicking "Refresh now" in the UI
  // therefore produces a *meaningful* delta: some of the original 50
  // departed, some heavy-spenders newly qualified. That demonstrates the
  // spec's static-segment behavior: doesn't auto-update on data changes,
  // but *does* recompute on explicit user refresh.
  const marchCampaign = await prisma.segment.create({
    data: {
      name: 'March Campaign Audience',
      description: 'Static snapshot for the March 2026 campaign — does not auto-update. Manual refresh re-evaluates the rule.',
      type: SegmentType.STATIC,
      rule: toJsonRule({ kind: 'compare', metric: 'tx_count_total', op: '>=', value: 10 }),
    },
  });

  console.log('▶ Pre-populating 50 members into the static March Campaign...');
  await prisma.segmentMember.createMany({
    data: randomCustomers.slice(0, 50).map((c) => ({
      segmentId: marchCampaign.id,
      customerId: c.id,
    })),
  });

  // ─── Summary ────────────────────────────────────────────────────────────
  const counts = {
    customers: await prisma.customer.count(),
    transactions: await prisma.transaction.count(),
    segments: await prisma.segment.count(),
    segmentMembers: await prisma.segmentMember.count(),
  };
  console.log('✔ Seed complete:', counts);
}

main()
  .catch((e) => {
    console.error('✖ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
