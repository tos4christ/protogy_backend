// ============================================================================
// CustomerPortal.js — place in frontend\src\components\CustomerPortal.js
// Mobile-first customer section: login/register, balance, usage chart,
// transactions, buy credit. Reached at  https://protogyglobal.io/#/customer
// Uses its OWN token (protogy_cust_token) so staff sessions are unaffected.
// ============================================================================
import React from 'react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts';

const BASE = process.env.REACT_APP_API_URL || '/api';

function custToken() { return localStorage.getItem('protogy_cust_token') || ''; }
async function amiFetch(path, opts = {}) {
  opts.headers = { ...(opts.headers || {}), Authorization: 'Bearer ' + custToken() };
  const res = await fetch(BASE + '/ami' + path, opts);
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch (e) { /* ignore */ }
    const err = new Error(msg); err.status = res.status; throw err;
  }
  return res.json();
}

// ---------------------------------------------------------------------------
class CustomerLogin extends React.Component {
  constructor(props) {
    super(props);
    this.state = { mode: 'login', fullName: '', phone: '', password: '',
                   meterSerial: '', busy: false, error: null };
    this.submit = this.submit.bind(this);
  }
  async submit(e) {
    e.preventDefault();
    this.setState({ busy: true, error: null });
    const { mode, fullName, phone, password, meterSerial } = this.state;
    try {
      const body = mode === 'login'
        ? { phone: phone.trim(), password }
        : { fullName: fullName.trim(), phone: phone.trim(), password, meterSerial: meterSerial.trim() };
      const res = await fetch(`${BASE}/ami/auth/${mode === 'login' ? 'login' : 'register'}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      localStorage.setItem('protogy_cust_token', data.token);
      localStorage.setItem('protogy_cust_name', data.name);
      this.props.onLogin();
    } catch (err) {
      this.setState({ busy: false, error: err.message });
    }
  }
  render() {
    const s = this.state;
    return (
      <div className="card cust-login">
        <div style={{ textAlign: 'center', marginBottom: 12 }}>
          <img alt="Protogy Global Services LTD" style={{ maxWidth: 200 }}
            src="/logo.png"
            onError={(e) => { e.target.onerror = null; e.target.src = '/logo.svg'; }} />
        </div>
        <h2 style={{ textAlign: 'center' }}>
          {s.mode === 'login' ? 'Customer Sign In' : 'Create Your Account'}
        </h2>
        {s.error && <div className="error">{s.error}</div>}
        <form onSubmit={this.submit}>
          <div className="controls" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
            {s.mode === 'register' && (
              <label>Full Name
                <input value={s.fullName} required
                  onChange={(e) => this.setState({ fullName: e.target.value })} />
              </label>
            )}
            <label>Phone Number
              <input type="tel" value={s.phone} required placeholder="0803..."
                onChange={(e) => this.setState({ phone: e.target.value })} />
            </label>
            <label>Password
              <input type="password" value={s.password} required minLength={8}
                onChange={(e) => this.setState({ password: e.target.value })} />
            </label>
            {s.mode === 'register' && (
              <label>Meter Serial Number (on your prepaid meter)
                <input value={s.meterSerial} required
                  onChange={(e) => this.setState({ meterSerial: e.target.value })} />
              </label>
            )}
            <button className="btn" type="submit" disabled={s.busy}>
              {s.busy ? 'Please wait…' : s.mode === 'login' ? 'Sign In' : 'Register'}
            </button>
            <button type="button" className="btn secondary"
              onClick={() => this.setState({ mode: s.mode === 'login' ? 'register' : 'login', error: null })}>
              {s.mode === 'login' ? 'New customer? Register with your meter serial' : 'Have an account? Sign in'}
            </button>
            <a className="muted" href="#/" style={{ textAlign: 'center' }}>Staff sign in →</a>
          </div>
        </form>
      </div>
    );
  }
}

// ---------------------------------------------------------------------------
class BuyCredit extends React.Component {
  constructor(props) {
    super(props);
    this.state = { amount: '', busy: false, error: null, result: null };
    this.buy = this.buy.bind(this);
  }
  async buy(e) {
    e.preventDefault();
    this.setState({ busy: true, error: null, result: null });
    try {
      const result = await amiFetch(`/meters/${encodeURIComponent(this.props.serial)}/purchase`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amountNaira: +this.state.amount }),
      });
      this.setState({ busy: false, result, amount: '' });
      this.props.onPurchased();
    } catch (err) {
      this.setState({ busy: false, error: err.message });
    }
  }
  render() {
    const s = this.state;
    const est = +s.amount > 0 && this.props.tariff > 0
      ? (+s.amount / this.props.tariff).toFixed(2) : null;
    return (
      <div className="card">
        <h2>Buy Credit — {this.props.serial}</h2>
        {s.error && <div className="error">{s.error}</div>}
        {s.result && (
          <div className="card" style={{ background: '#eef8f0' }}>
            <b>Purchase successful!</b><br />
            {s.result.kwh} kWh for ₦{s.result.amountNaira}<br />
            Token: <span className="vend-token">{s.result.token.replace(/(\d{4})(?=\d)/g, '$1-')}</span>
            <p className="muted">{s.result.note}</p>
          </div>
        )}
        <form onSubmit={this.buy}>
          <div className="controls">
            <label>Amount (₦, min 100)
              <input type="number" min="100" step="50" value={s.amount} required
                onChange={(e) => this.setState({ amount: e.target.value })} />
            </label>
            <button className="btn" type="submit" disabled={s.busy}>
              {s.busy ? 'Processing…' : 'Buy Credit'}
            </button>
          </div>
          {est && <p className="muted">≈ {est} kWh at ₦{this.props.tariff}/kWh</p>}
        </form>
      </div>
    );
  }
}

// ---------------------------------------------------------------------------
class CustomerPortal extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      loggedIn: !!custToken(),
      me: null, serial: '', usage: null, txns: null,
      tab: 'home', days: 30, error: null,
    };
    this.load = this.load.bind(this);
    this.logout = this.logout.bind(this);
  }

  componentDidMount() { if (this.state.loggedIn) this.load(); }

  async load() {
    try {
      const me = await amiFetch('/me');
      const serial = this.state.serial || (me.meters[0] ? me.meters[0].meter_serial : '');
      this.setState({ me, serial, error: null });
      if (serial) {
        const [usage, txns] = await Promise.all([
          amiFetch(`/meters/${encodeURIComponent(serial)}/usage?days=${this.state.days}`),
          amiFetch(`/meters/${encodeURIComponent(serial)}/transactions`),
        ]);
        this.setState({ usage, txns });
      }
    } catch (err) {
      if (err.status === 401 || err.status === 403) this.logout();
      else this.setState({ error: err.message });
    }
  }

  logout() {
    localStorage.removeItem('protogy_cust_token');
    localStorage.removeItem('protogy_cust_name');
    this.setState({ loggedIn: false, me: null, usage: null, txns: null });
  }

  render() {
    if (!this.state.loggedIn) {
      return <main className="page cust-page"><CustomerLogin onLogin={() => { this.setState({ loggedIn: true }, this.load); }} /></main>;
    }
    const { me, serial, usage, txns, tab, error } = this.state;
    const meter = me && me.meters.find((m) => m.meter_serial === serial);
    const chartData = usage ? usage.daily.map((d) => ({
      day: String(d.day).slice(5, 10), kwh: +d.kwh_used || 0,
    })) : [];
    return (
      <div>
        <header className="app-header">
          <img className="brand-logo" alt="Protogy" src="/logo.png"
            onError={(e) => { e.target.onerror = null; e.target.src = '/logo.svg'; }} />
          <div style={{ marginLeft: 'auto', fontSize: 13 }}>
            {localStorage.getItem('protogy_cust_name')}
            <button className="btn secondary" style={{ padding: '4px 10px', marginLeft: 8 }}
              onClick={this.logout}>Sign out</button>
          </div>
        </header>

        <nav className="cust-tabs">
          {[['home', 'My Meter'], ['usage', 'Usage'], ['buy', 'Buy Credit'], ['txns', 'History']].map(([k, label]) => (
            <button key={k} className={tab === k ? 'active' : ''}
              onClick={() => this.setState({ tab: k })}>{label}</button>
          ))}
        </nav>

        <main className="page cust-page">
          {error && <div className="error">{error}</div>}
          {me && me.meters.length > 1 && (
            <div className="controls">
              <label>Meter
                <select value={serial}
                  onChange={(e) => this.setState({ serial: e.target.value, usage: null, txns: null }, this.load)}>
                  {me.meters.map((m) => <option key={m.meter_serial} value={m.meter_serial}>{m.meter_serial}</option>)}
                </select>
              </label>
            </div>
          )}

          {tab === 'home' && meter && (
            <div className="card">
              <h2>Meter {meter.meter_serial}</h2>
              <div className="stat-grid">
                <div className="stat">
                  <div className="v" style={{ color: +meter.balance_kwh < 10 ? '#d64545' : '#2f9e44' }}>
                    {(+meter.balance_kwh).toFixed(1)} kWh
                  </div>
                  <div className="l">Credit balance {+meter.balance_kwh < 10 && '— LOW, buy credit soon'}</div>
                </div>
                <div className="stat">
                  <div className="v">
                    <span className={'badge ' + (meter.connectivity === 'online' ? 'online' : 'offline')}>
                      {meter.connectivity}
                    </span>
                  </div>
                  <div className="l">Meter status{meter.last_seen_at ? ' · seen ' + new Date(meter.last_seen_at).toLocaleTimeString() : ''}</div>
                </div>
                <div className="stat"><div className="v">₦{meter.tariff_naira_kwh}</div><div className="l">Tariff per kWh</div></div>
                {usage && (
                  <div className="stat"><div className="v">₦{usage.estimatedCostNaira}</div>
                    <div className="l">Spent (last {usage.days} days · {usage.totalKwh} kWh)</div></div>
                )}
              </div>
            </div>
          )}

          {tab === 'usage' && (
            <div className="card">
              <h2>Daily Usage (kWh)</h2>
              <div className="controls">
                <label>Period
                  <select value={this.state.days}
                    onChange={(e) => this.setState({ days: +e.target.value }, this.load)}>
                    <option value={7}>Last 7 days</option>
                    <option value={30}>Last 30 days</option>
                    <option value={90}>Last 90 days</option>
                  </select>
                </label>
              </div>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="day" tick={{ fontSize: 10 }} /><YAxis />
                  <Tooltip formatter={(v) => v + ' kWh'} />
                  <Bar isAnimationActive={false} dataKey="kwh" name="kWh" fill="#0b6ba8" />
                </BarChart>
              </ResponsiveContainer>
              {usage && <p className="muted">Total {usage.totalKwh} kWh ≈ ₦{usage.estimatedCostNaira}</p>}
            </div>
          )}

          {tab === 'buy' && meter && (
            <BuyCredit serial={meter.meter_serial} tariff={+meter.tariff_naira_kwh}
              onPurchased={this.load} />
          )}

          {tab === 'txns' && txns && (
            <div className="card">
              <h2>Purchase History</h2>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Date</th><th>Amount</th><th>kWh</th><th>Token</th><th>Status</th></tr></thead>
                  <tbody>
                    {txns.transactions.map((t) => (
                      <tr key={t.txn_id}>
                        <td>{new Date(t.created_at).toLocaleDateString()}</td>
                        <td>₦{t.amount_naira}</td>
                        <td>{t.kwh}</td>
                        <td className="vend-token">{String(t.token).replace(/(\d{4})(?=\d)/g, '$1-')}</td>
                        <td><span className={'badge ' + (t.status === 'applied' ? 'online' : 'auto_registered')}>{t.status}</span></td>
                      </tr>
                    ))}
                    {txns.transactions.length === 0 &&
                      <tr><td colSpan="5" className="muted">No purchases yet.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </main>
      </div>
    );
  }
}

export default CustomerPortal;
