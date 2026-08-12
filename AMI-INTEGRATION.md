# PROTOGY AMI MODULE — INSTALLATION & INTEGRATION GUIDE

New capability: customer-facing prepaid metering (usage history, billing,
credit purchase) + device REST API — added WITHOUT touching any existing
feeder/DAR functionality. Follow these steps exactly.

---

## STEP 1 — Database (run once)
Copy `ami_schema.sql` to the server and run:
```powershell
psql -U postgres -h localhost -d protogy -f ami_schema.sql
```
Creates: `customers`, `prepaid_meters`, `prepaid_readings` (hypertable),
`credit_transactions`, and the `ami_daily_usage` aggregate. No existing
tables are modified.

## STEP 2 — Backend
1. Copy `ami.js` into `backend\ami.js`.
2. Edit `backend\server.js` — add ONE import and ONE mount line.

Add with the other requires at the top:
```js
const amiRoutes = require('./ami');
```

Add this line BEFORE the `app.use('/api', requireAuth, routes);` line
(order matters — the AMI router does its own auth):
```js
app.use('/api/ami', amiRoutes);   // customer portal + prepaid device REST API
```

3. Restart the backend service.

## STEP 3 — Frontend
1. Copy `CustomerPortal.js` into `frontend\src\components\CustomerPortal.js`.
2. Edit `frontend\src\App.js`:

Add import:
```js
import CustomerPortal from './components/CustomerPortal';
```

At the very TOP of App's `render()` method (before `if (!session)`), add:
```js
    if (window.location.hash.startsWith('#/customer')) {
      return <CustomerPortal />;
    }
```

And in `componentDidMount()` add a hash listener so the URL switch works
without reload:
```js
    window.addEventListener('hashchange', () => this.forceUpdate());
```

3. Edit `frontend\src\components\Login.js` — add a customer link inside the
   form's controls div (last element):
```js
            <a className="muted" href="#/customer" style={{ textAlign: 'center' }}>
              Prepaid meter customer? Sign in here →
            </a>
```

4. Append the MOBILE RESPONSIVE CSS below to `frontend\src\App.css`.
5. `npm run build`, hard-refresh.

## STEP 4 — Mobile responsive CSS (append to App.css)
```css
/* ---- Mobile responsiveness ---- */
@media (max-width: 720px) {
  .app-header { flex-wrap: wrap; padding: 10px 12px; gap: 10px; }
  .brand-logo { height: 34px; }
  .header-clock { order: 2; }
  .tabs { order: 3; width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .tabs button { white-space: nowrap; padding: 8px 10px; font-size: 13px; }
  .page { padding: 12px 10px; }
  .card { padding: 12px; }
  .controls { gap: 8px; }
  .controls label { flex: 1 1 45%; min-width: 130px; }
  .controls input, .controls select { width: 100%; min-width: 0; font-size: 16px; }
  .btn { padding: 12px 16px; }          /* finger-sized touch targets */
  .stat-grid { grid-template-columns: repeat(2, 1fr); }
  .stat .v { font-size: 18px; }
  table.data th, table.data td { padding: 6px 6px; font-size: 12px; }
  .table-wrap { max-height: 420px; }
  .pager { flex-wrap: wrap; }
}
@media (max-width: 420px) {
  .stat-grid { grid-template-columns: 1fr; }
  .controls label { flex: 1 1 100%; }
}

/* ---- Customer portal ---- */
.cust-tabs { display: flex; background: #fff; border-bottom: 1px solid #dde5ec;
  position: sticky; top: 0; z-index: 5; }
.cust-tabs button { flex: 1; border: none; background: none; padding: 12px 4px;
  font-size: 14px; color: #55707f; cursor: pointer; }
.cust-tabs button.active { color: #0b3d61; font-weight: 700;
  border-bottom: 3px solid #e8452c; }
.cust-page { max-width: 640px; }
.cust-login { max-width: 400px; margin: 40px auto; }
.vend-token { font-family: Consolas, monospace; font-weight: 700;
  letter-spacing: 1px; color: #0b3d61; }
```

---

## HOW THE PREPAID FLOW WORKS

1. **Admin registers the meter** (staff token, admin role):
   `POST /api/ami/admin/meters` `{ "meterSerial": "PM-0001", "tariffNairaPerKwh": 68 }`
   → response contains `apiKey` ONCE. Flash serial + apiKey + server URL to
   the meter. `GET /api/ami/admin/meters` lists all prepaid meters.

2. **Customer self-registers** on the portal (`#/customer` → Register) with
   name, phone, password, and the meter serial — this links the meter to
   their account. Or they sign in later with phone + password.

3. **The meter reports over REST** (HTTPS to protogyglobal.io, header
   `x-meter-key: <apiKey>`):
   - `POST /api/ami/device/reading`
     `{ "ts": "...", "energyKwh": 1234.5, "powerW": 850, "voltage": 229.8, "balanceKwh": 42.1 }`
     (send every 5–15 min; `ts` unique per reading; buffered resends safe.)
   - `GET /api/ami/device/credits` → `{ pendingCredits: [ { txnId, kwh, token } ] }`
     (poll each report cycle; apply any pending credit.)
   - `POST /api/ami/device/credits/:txnId/ack` → marks applied, tops up the
     server-side balance. (Customers can also type the 20-digit token on the
     meter keypad — the meter should then still ack via the same endpoint.)

4. **Customer portal** (all JWT role `customer`):
   - `POST /api/ami/auth/login` `{ phone, password }` → `{ token, name }`
   - `POST /api/ami/auth/register` `{ fullName, phone, password, meterSerial }`
   - `GET /api/ami/me` → profile + meters + balances + online status
   - `GET /api/ami/meters/:serial/usage?days=30` → daily kWh + cost estimate
   - `GET /api/ami/meters/:serial/transactions` → purchase history
   - `POST /api/ami/meters/:serial/purchase` `{ "amountNaira": 2000 }`
     → `{ kwh, token, txnId }`

## PAYMENTS — DEMO MODE, READ BEFORE GO-LIVE
`purchase` currently records payment instantly as 'paid' (demo mode) so you
can test the full loop with no gateway. Before charging real money,
integrate a gateway (Paystack/Flutterwave):
1. `purchase` → create transaction as `pending` + initialize gateway payment,
   return the gateway checkout URL to the frontend.
2. Add a gateway webhook endpoint that verifies the signature and flips the
   transaction to `paid` — only then does the meter see the credit.
Never go live with demo mode reachable from the internet.

## SECURITY ISOLATION (why nothing breaks)
- Separate tables; zero changes to feeder tables/views.
- Customer JWTs carry role `customer` — staff endpoints reject them, and the
  AMI endpoints reject staff tokens where inappropriate.
- Customers can only query meters linked to their own customer_id.
- Devices authenticate per-meter with an unguessable 48-hex-char api key and
  can only touch their own serial.
- Separate localStorage keys — a phone can hold a staff and a customer
  session without conflict.
