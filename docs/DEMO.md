# Guided demo

Two ways to see Hive work. Neither needs a model key on your laptop.

| | What runs | Agents | Model call |
|---|---|---|---|
| **A. Seeded dashboard** (`scripts/seed-demo.ts`) | a local hub on a temp copy of the sample project, filled by a script | three *scripted* sessions, labelled as such | none |
| **B. Real agents** on `hive-playground` | your hub (local or hosted) + `hive-connect` on each laptop | real Claude Code (or Muse Code) sessions | on the hub, if `MODEL_API_KEY` is set there |

The sample project is `hive-playground`, a small TypeScript billing app that keeps prices in decimal dollars.
It lives next to this repository (`../hive-playground`, or set `HIVE_PLAYGROUND`).

## A. Seeded dashboard (about two minutes)

```bash
npm install && npm run build:web
node --disable-warning=ExperimentalWarning scripts/seed-demo.ts --port 4318      # add --keep to keep the temp copy
```

The script copies the playground to a temp folder, starts a hub on `127.0.0.1:4318` with a file database there,
creates member tokens, registers a pricing, an invoice and a UI agent with their own tokens and declares their
intents. It then proposes and acknowledges the `getPrice` agreement, **edits the consumer files itself** (logged
as a script edit, not an agent edit), applies `change_signature` through Hive and runs `npm test` as
verification, which **fails by design** because the function body still returns dollars. It prints the
dashboard URL and a throwaway admin token to stderr (or uses `$HIVE_TOKEN` from your shell without printing it)
and keeps the sessions alive until Ctrl-C.

What to look at in `http://127.0.0.1:4318/ui/`:
1. **Overview:** three agents (two members); the `getPrice` finding between the pricing and invoice agents; the
   UI agent is not involved.
2. **Agreements:** the Ghost Contract `getPrice(sku, unit: 'cents' | 'dollars')` with its acknowledgements, the
   `change_signature` applied through Hive, and a verification run that **failed** (exit code shown), so the
   agreement is not *verified*. The script logs each state it reached to stderr.
3. **Activity:** every step in order, including the script's own edit.

For a scripted end-to-end replay without the dashboard: `npm run demo` (exit 0 means every state was reached).

## B. Real agents on the playground

1. **Hub.** Self-host one (see [SELF_HOSTING.md](SELF_HOSTING.md)) with `HIVE_PROJECT_ROOT` or `HIVE_REPO_URL`
   pointing at `hive-playground`. Sign in as admin and send each person an invite link from Connect.
2. **Each person**, on their own laptop: clone `hive-playground`, `npm install`, open the invite link, and run
   the Connect command in that folder (`hive-connect connect --hub <hub>`; see the README for the pre-publish
   install). Then start Claude Code in that folder.
3. **Give each agent one task** (verbatim from the playground README):
   - **Pricing agent:** "Money bugs keep appearing from floating point. Change pricing so that `getPrice`
     returns integer cents instead of decimal dollars, and update the catalog and `applyDiscount` accordingly.
     Keep tests green."
   - **Invoice agent:** "Add a `buildReceipt(invoice)` function in `src/invoice.ts` that returns a plain-text
     receipt with one line per item and the total in dollars, and add tests for it."
   - **UI agent:** "Rename the export button label to 'Download invoice' and add a `cancelButtonLabel`. Add a
     test for `renderButton`."

What should happen: the pricing and invoice agents share `getPrice` and disagree about its unit. Hive raises a
finding as soon as both intents are declared (and again when the pricing change would break the invoice code);
each agent sees it in its prompt context; one proposes a Ghost Contract (an explicit `unit` parameter or a new
`getPriceCents`), both acknowledge it, and `npm test` on the real code is what finally makes it *verified*.
The UI agent is never blocked.

Write down honestly what you observe: whether each agent changed its plan after reading Hive's message, which
edits went through paths Hive does not intercept (shell edits), and whether model analysis ran on the hub or was
*unavailable*. Do not present scenario A as live agents.

## Status

`npm run demo` is a labelled scripted replay. `scripts/seed-demo.ts` is a manual tool (not part of `npm test`);
it needs `../hive-playground` present. Scenario B with two real people on two
laptops has **not** been run yet; see `docs/PROGRESS.md`.
