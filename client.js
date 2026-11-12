/**
 * Client half of the Alibaba Token Plan bundle.
 *
 * Two registrations, both fed by the Host's same-origin route (the browser
 * cannot sign the Aliyun request itself):
 *  - `conversation.composer.dock`: the monthly quota strip under the composer.
 *  - `settings.section`: the Alibaba Token Plan page with the full reading.
 *
 * The strip is provider-aware: it appears only while the session's selected
 * model belongs to an Alibaba provider (`alibaba` by default). The DeepSeek
 * balance and OpenCode Go strips use the same rule with their own provider ids
 * (`deepseek-account`, `opencode-go`), so the three never render together — even
 * though Alibaba also serves models whose names start with `deepseek-`.
 *
 * Plain React only: no Harness Client package is imported, so nothing here can
 * break when those packages change.
 */
window.__ModuleLoader__.load({
  id: '@wasp/dsh-alibaba-token-plan',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Client locale namespace and host route, both owned by this bundle. */
    const NS = 'alibaba-token-plan';
    const ENDPOINT = '/alibaba-token-plan/usage.json';
    /** Poll cadence. Each poll forces the Host to re-read upstream. */
    const POLL_MS = 60000;
    /** Age past which the reading is called out as lagging. */
    const LAG_MS = 180000;

    /** English copy. */
    const en = {
      title: 'Alibaba Token Plan',
      description:
        "The current subscription month's Token Plan quota, read from the Alibaba Cloud Model Studio console.",
      monthly: 'Monthly',
      used: 'used',
      resets: 'Resets',
      resetUnknown: 'reset time unknown',
      loading: 'Loading…',
      unavailable: 'Token Plan usage unavailable',
      notConnected: 'Token Plan: not connected',
      refresh: 'Refresh',
      updated: 'Updated',
      credential: 'Credential',
      endpoint: 'Endpoint',
      warnAt: 'Warn threshold',
      plan: 'Plan',
      stale: 'Showing the last good reading; the latest refresh failed.',
      behind: 'behind',
      lastError: 'Last error',
      hint:
        'The AccessKey comes from the Harness credential store. A Token Plan model key (sk-sp-...) cannot read plan usage.',
      credits: 'Seat credits',
      creditsUsed: 'Used',
      creditsRemaining: 'Remaining',
      creditsTotal: 'Total',
      creditsNone: 'No seat credits are reported for this plan; the monthly window is percentage-only.',
      creditRefresh: 'Refresh credit',
      visibility:
        'Shows under the composer only while the selected model is served by an Alibaba provider (`alibaba`). DeepSeek and OpenCode models show their own strips instead.',
      never: 'never',
      percentOfQuota: 'of the monthly quota used',
    };

    /** Bulgarian copy, matching the deployment language. */
    const bg = {
      title: 'Alibaba Token Plan',
      description:
        'Месечната квота на Alibaba Cloud Token Plan за текущия абонаментен месец, четена от конзолата на Model Studio.',
      monthly: 'Месечно',
      used: 'използвано',
      resets: 'Нулиране',
      resetUnknown: 'неизвестно време за нулиране',
      loading: 'Зареждане…',
      unavailable: 'Няма данни за Token Plan',
      notConnected: 'Token Plan: няма връзка',
      refresh: 'Обнови',
      updated: 'Обновено',
      credential: 'Идентификационни данни',
      endpoint: 'Адрес',
      warnAt: 'Праг за предупреждение',
      plan: 'План',
      stale: 'Показани са последните валидни данни; последното обновяване се провали.',
      behind: 'закъснение',
      lastError: 'Последна грешка',
      hint:
        'AccessKey идва от хранилището за идентификационни данни на Harness. Ключ за модел (sk-sp-...) не може да чете използването.',
      credits: 'Кредити за места',
      creditsUsed: 'Използвани',
      creditsRemaining: 'Останали',
      creditsTotal: 'Общо',
      creditsNone: 'Този план не отчита кредити за места; месечният прозорец е само процент.',
      creditRefresh: 'Обнови кредитите',
      visibility:
        'Показва се под полето за въвеждане само когато избраният модел е през Alibaba доставчик (`alibaba`). Моделите на DeepSeek и OpenCode показват своите ленти.',
      never: 'никога',
      percentOfQuota: 'от месечната квота',
    };

    /** Active translator: the Client locale service replaces this during apply. */
    let t = (key) => en[key] ?? key;
    /** The client root context, captured during apply for lazy service lookup. */
    let rootCtx = null;

    /** Meter severity to theme token. */
    const LEVEL_TOKEN = {
      ok: 'var(--dsw-alias-state-success-primary)',
      warning: 'var(--dsw-alias-state-warn-primary)',
      critical: 'var(--dsw-alias-state-error-primary)',
    };

    /** Component-local styles, removed with the component that renders them. */
    function Styles() {
      return h('style', {
        dangerouslySetInnerHTML: {
          __html: `
.atp-strip { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 2px 2px 0; font-size: 11px; line-height: 1.4; color: var(--dsw-alias-label-secondary); }
.atp-brand { font-weight: 600; color: var(--dsw-alias-label-primary); }
.atp-meter { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.atp-label { white-space: nowrap; }
.atp-track { position: relative; width: 46px; height: 4px; border-radius: 999px; overflow: hidden; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); }
.atp-fill { position: absolute; inset: 0 auto 0 0; border-radius: 999px; }
.atp-value { font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary); }
.atp-reset { white-space: nowrap; }
.atp-credit { color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; white-space: nowrap; }
.atp-error { color: var(--dsw-alias-state-error-primary); }
.atp-age { color: var(--dsw-alias-state-warn-primary); white-space: nowrap; }
.atp-page { display: flex; flex-direction: column; gap: 16px; padding: 4px 2px; color: var(--dsw-alias-label-primary); }
.atp-page-title { font-size: 15px; font-weight: 600; }
.atp-page-description { font-size: 12px; color: var(--dsw-alias-label-secondary); max-width: 62ch; }
.atp-hero { display: flex; flex-direction: column; gap: 8px; padding: 14px 16px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }
.atp-hero-top { display: flex; align-items: baseline; gap: 8px; }
.atp-hero-value { font-size: 32px; line-height: 1; font-weight: 650; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
.atp-hero-suffix { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.atp-big-track { position: relative; width: 100%; height: 6px; border-radius: 999px; overflow: hidden; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); }
.atp-big-fill { position: absolute; inset: 0 auto 0 0; border-radius: 999px; }
.atp-hero-meta { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.atp-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); overflow: hidden; }
.atp-row { display: grid; grid-template-columns: minmax(90px, 1fr) auto; gap: 12px; align-items: center; padding: 10px 12px; border-top: 1px solid var(--dsw-alias-border-l1); font-size: 12px; }
.atp-row:first-child { border-top: 0; }
.atp-row-head { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); }
.atp-meta { display: flex; flex-wrap: wrap; gap: 8px 18px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.atp-meta code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--dsw-alias-label-primary); }
.atp-actions { display: flex; align-items: center; gap: 10px; }
.atp-button { font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); cursor: pointer; }
.atp-button:disabled { opacity: 0.6; cursor: default; }
.atp-notice { font-size: 12px; padding: 8px 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); }
.atp-notice-warn { color: var(--dsw-alias-state-warn-primary); }
.atp-notice-error { color: var(--dsw-alias-state-error-primary); }
.atp-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); max-width: 72ch; }
`,
        },
      });
    }

    /** Format a percentage with at most one decimal. */
    function percentText(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '–';
      return `${Number(value.toFixed(1))}%`;
    }

    /** Format a credit amount. */
    function creditText(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '–';
      try {
        return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
      } catch {
        return value.toFixed(2);
      }
    }

    /**
     * Format a reset time as the local clock time plus a countdown.
     * @param iso - the API's ISO timestamp.
     * @param now - current epoch milliseconds.
     * @returns display text, or null when the time is unknown.
     */
    function resetText(iso, now) {
      if (typeof iso !== 'string' || iso === '') return null;
      const at = Date.parse(iso);
      if (!Number.isFinite(at)) return iso;
      const remaining = at - now;
      const minutes = Math.max(0, Math.round(remaining / 60000));
      const hours = Math.floor(minutes / 60);
      const days = Math.floor(hours / 24);
      const countdown =
        remaining <= 0
          ? 'now'
          : days > 0
            ? `${days}d ${hours % 24}h`
            : hours > 0
              ? `${hours}h ${minutes % 60}m`
              : `${minutes}m`;
      const clock = new Date(at).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
      return `${clock} (in ${countdown})`;
    }

    /** Short countdown for the compact strip. */
    function countdownText(iso, now) {
      if (typeof iso !== 'string' || iso === '') return null;
      const at = Date.parse(iso);
      if (!Number.isFinite(at)) return null;
      const minutes = Math.max(0, Math.round((at - now) / 60000));
      const hours = Math.floor(minutes / 60);
      const days = Math.floor(hours / 24);
      if (minutes <= 0) return 'now';
      if (days > 0) return `${days}d ${hours % 24}h`;
      if (hours > 0) return `${hours}h ${minutes % 60}m`;
      return `${minutes}m`;
    }

    /**
     * Subscribe to the Host's usage route.
     * @param withCredits - whether the seat credit reading is wanted too.
     * @returns the current state plus a manual refresh trigger.
     */
    function useUsage(withCredits) {
      const [state, setState] = React.useState({ status: 'loading', payload: null });
      const [, setTick] = React.useState(0);
      const load = React.useCallback(
        async (forceMeters, forceCredits) => {
          setState((current) => ({
            ...current,
            status: current.payload === null ? 'loading' : current.status,
            pending: true,
          }));
          const params = new URLSearchParams({ refresh: '1' });
          if (withCredits === true) params.set('credits', forceCredits === true ? 'force' : '1');
          try {
            const response = await fetch(`${ENDPOINT}?${params.toString()}`, {
              headers: { accept: 'application/json' },
              cache: 'no-store',
            });
            const payload = await response.json();
            setState({ status: 'ready', payload, pending: false });
          } catch (error) {
            setState((current) => ({
              status: current.payload === null ? 'error' : 'ready',
              payload: current.payload,
              error: error instanceof Error ? error.message : String(error),
              pending: false,
            }));
          }
        },
        [withCredits],
      );
      React.useEffect(() => {
        void load(true, false);
        const timer = setInterval(() => void load(true, false), POLL_MS);
        return () => clearInterval(timer);
      }, [load]);
      React.useEffect(() => {
        const timer = setInterval(() => setTick((value) => value + 1), 30000);
        return () => clearInterval(timer);
      }, []);
      return { state, refresh: () => void load(true, true), now: Date.now() };
    }

    /**
     * Read the provider of the model currently selected for this session, so the
     * strip can show only while an Alibaba model is active.
     * @param sessionId - the slot's session id.
     * @returns the provider id, or null when none is selected or unknown.
     */
    function useSelectedProvider(sessionId) {
      const [provider, setProvider] = React.useState(null);
      React.useEffect(() => {
        const dirs = rootCtx === null ? null : rootCtx.get('modelDirectories') ?? null;
        if (sessionId === null || sessionId === undefined || dirs === null) {
          setProvider(null);
          return;
        }
        let directory;
        try {
          directory = dirs.directoryFor(sessionId);
        } catch {
          setProvider(null);
          return;
        }
        const apply = () => {
          const snapshot = directory.store.getSnapshot();
          const current = snapshot !== null && typeof snapshot === 'object' ? snapshot.current : null;
          setProvider(
            current !== null && typeof current === 'object' && typeof current.provider === 'string'
              ? current.provider
              : null,
          );
        };
        apply();
        const unsubscribe = directory.store.subscribe(apply);
        return () => {
          if (typeof unsubscribe === 'function') unsubscribe();
        };
      }, [sessionId]);
      return provider;
    }

    /**
     * The visibility rule shared by the strip and the settings hint: the
     * selected provider id must contain `providerMatch` and none of
     * `providerExclude`. This is the same rule the DeepSeek and OpenCode
     * plugins apply with their own ids, which keeps the three strips disjoint.
     */
    function providerMatches(provider, match, exclude) {
      if (typeof provider !== 'string' || provider === '') return false;
      const value = provider.toLowerCase();
      if (typeof match !== 'string' || match === '' || value.indexOf(match.toLowerCase()) === -1) {
        return false;
      }
      return !exclude.some(
        (item) => typeof item === 'string' && item !== '' && value.indexOf(item.toLowerCase()) !== -1,
      );
    }

    /**
     * The ambient strip under the composer. Renders only while the session's
     * selected model belongs to an Alibaba provider; hidden otherwise.
     */
    function UsageStrip(props) {
      const { state, now } = useUsage(false);
      const provider = useSelectedProvider(props.sessionId);
      const payload = state.payload;
      const match =
        payload !== null && typeof payload.providerMatch === 'string' && payload.providerMatch !== ''
          ? payload.providerMatch
          : 'alibaba';
      const exclude = payload !== null && Array.isArray(payload.providerExclude) ? payload.providerExclude : [];
      if (!providerMatches(provider, match, exclude)) return null;
      if (payload === null) {
        return h(
          'div',
          { className: 'atp-strip' },
          h(Styles, null),
          h('span', { className: 'atp-brand' }, 'Token Plan'),
          h('span', null, state.status === 'loading' ? t('loading') : t('unavailable')),
        );
      }
      const monthly = payload.monthly !== null && typeof payload.monthly === 'object' ? payload.monthly : null;
      if (monthly === null) {
        return h(
          'div',
          {
            className: 'atp-strip',
            'data-component': 'alibaba-token-plan-strip',
            title: state.error ?? payload.error ?? '',
          },
          h(Styles, null),
          h('span', { className: 'atp-brand' }, 'Token Plan'),
          h('span', { className: 'atp-error' }, t('notConnected')),
        );
      }
      const percent = typeof monthly.percent === 'number' ? monthly.percent : null;
      const width = percent === null ? 0 : Math.max(2, Math.min(100, percent));
      const reset = resetText(monthly.resetsAt, now);
      const countdown = countdownText(monthly.resetsAt, now);
      const age = typeof payload.fetchedAt === 'string' ? Date.now() - Date.parse(payload.fetchedAt) : null;
      const lag = age !== null && Number.isFinite(age) && age > LAG_MS ? age : null;
      const credits =
        payload.credits !== null &&
        typeof payload.credits === 'object' &&
        payload.credits.available === true &&
        typeof payload.credits.remaining === 'number'
          ? payload.credits
          : null;
      return h(
        'div',
        { className: 'atp-strip', 'data-component': 'alibaba-token-plan-strip' },
        h(Styles, null),
        h('span', { className: 'atp-brand' }, 'Token Plan'),
        h(
          'span',
          {
            className: 'atp-meter',
            title: `${t('monthly')}: ${percentText(percent)} ${t('used')}${reset === null ? '' : ` — ${t('resets').toLowerCase()} ${reset}`}`,
          },
          h('span', { className: 'atp-label' }, t('monthly')),
          h(
            'span',
            { className: 'atp-track' },
            h('span', {
              className: 'atp-fill',
              style: { width: `${width}%`, background: LEVEL_TOKEN[monthly.level] ?? LEVEL_TOKEN.ok },
            }),
          ),
          h('span', { className: 'atp-value' }, percentText(percent)),
        ),
        countdown === null
          ? null
          : h('span', { className: 'atp-reset' }, `${t('resets').toLowerCase()} in ${countdown}`),
        credits === null
          ? null
          : h(
              'span',
              {
                className: 'atp-credit',
                title: `${t('credits')}: ${creditText(credits.remaining)} / ${creditText(credits.total)}`,
              },
              `${t('credits')} ${creditText(credits.remaining)}/${creditText(credits.total)}`,
            ),
        payload.stale === true ? h('span', { className: 'atp-error' }, t('stale')) : null,
        lag === null ? null : h('span', { className: 'atp-age' }, `${t('behind')} ${Math.round(lag / 60000)}m`),
      );
    }

    /**
     * The Alibaba Token Plan settings page.
     * @returns the full reading with its provenance and a manual refresh.
     */
    function UsageSettings() {
      const { state, refresh, now } = useUsage(true);
      const payload = state.payload;
      const monthly = payload !== null && payload.monthly !== null && typeof payload.monthly === 'object' ? payload.monthly : null;
      const credits =
        payload !== null && payload.credits !== null && typeof payload.credits === 'object' ? payload.credits : null;
      const updated = payload?.fetchedAt == null ? t('never') : new Date(payload.fetchedAt).toLocaleString();
      const reset = monthly === null ? null : resetText(monthly.resetsAt, now);
      const percent = monthly === null || typeof monthly.percent !== 'number' ? null : monthly.percent;
      const width = percent === null ? 0 : Math.max(2, Math.min(100, percent));
      const creditsReadFinished = credits !== null && credits.fetchedAt !== null;
      return h(
        'div',
        { className: 'atp-page', 'data-component': 'alibaba-token-plan-settings' },
        h(Styles, null),
        h('div', { className: 'atp-page-title' }, t('title')),
        h('div', { className: 'atp-page-description' }, t('description')),
        state.error != null || payload?.error != null
          ? h(
              'div',
              { className: 'atp-notice atp-notice-error' },
              `${t('lastError')}: ${state.error ?? payload.error}`,
            )
          : null,
        payload?.stale === true ? h('div', { className: 'atp-notice atp-notice-warn' }, t('stale')) : null,
        monthly === null
          ? h('div', { className: 'atp-hint' }, state.status === 'loading' ? t('loading') : t('unavailable'))
          : h(
              'div',
              { className: 'atp-hero' },
              h(
                'div',
                { className: 'atp-hero-top' },
                h('span', { className: 'atp-hero-value' }, percentText(percent)),
                h('span', { className: 'atp-hero-suffix' }, t('percentOfQuota')),
              ),
              h(
                'div',
                { className: 'atp-big-track' },
                h('span', {
                  className: 'atp-big-fill',
                  style: { width: `${width}%`, background: LEVEL_TOKEN[monthly.level] ?? LEVEL_TOKEN.ok },
                }),
              ),
              h(
                'div',
                { className: 'atp-hero-meta' },
                h('span', null, `${t('resets')}: `, h('code', null, reset ?? t('resetUnknown'))),
                h('span', null, `${t('plan')}: `, h('code', null, payload?.planLabel ?? '–')),
              ),
            ),
        credits !== null && credits.available === true
          ? h(
              'div',
              { className: 'atp-card' },
              h(
                'div',
                { className: 'atp-row atp-row-head' },
                h('span', null, t('credits')),
                h('span', null, t('creditsRemaining')),
              ),
              h(
                'div',
                { className: 'atp-row' },
                h('span', null, t('creditsTotal')),
                h('span', null, creditText(credits.total)),
              ),
              h(
                'div',
                { className: 'atp-row' },
                h('span', null, t('creditsUsed')),
                h('span', null, creditText(credits.used)),
              ),
              h(
                'div',
                { className: 'atp-row' },
                h('span', null, t('creditsRemaining')),
                h('span', null, creditText(credits.remaining)),
              ),
            )
          : creditsReadFinished
            ? h('div', { className: 'atp-hint' }, t('creditsNone'))
            : null,
        h(
          'div',
          { className: 'atp-meta' },
          h('span', null, `${t('updated')}: `, h('code', null, updated)),
          h('span', null, `${t('credential')}: `, h('code', null, payload?.credentialSource ?? '–')),
          h('span', null, `${t('endpoint')}: `, h('code', null, payload?.source ?? '–')),
          h(
            'span',
            null,
            `${t('warnAt')}: `,
            h('code', null, payload?.warnPercent == null ? '–' : `${payload.warnPercent}%`),
          ),
        ),
        h(
          'div',
          { className: 'atp-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'atp-button',
              disabled: state.pending === true,
              onClick: refresh,
            },
            state.pending === true ? t('loading') : t('refresh'),
          ),
        ),
        h('div', { className: 'atp-hint' }, t('visibility')),
        h('div', { className: 'atp-hint' }, t('hint')),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        t = ctx.locale.bind(NS);
        rootCtx = ctx;
        ctx.effect(() => {
          const disposers = [];
          const register = (locale, dict) => {
            try {
              disposers.push(ctx.locale.register(NS, locale, dict));
            } catch (error) {
              console.error(`alibaba-token-plan: ${locale} dictionary not registered`, error);
            }
          };
          register('en', en);
          register('bg', bg);
          return () => {
            for (const dispose of disposers) dispose();
          };
        }, 'alibaba-token-plan: dictionaries');
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register({ name: 'conversation.composer.dock', id: 'alibaba-token-plan', order: 6 }, UsageStrip),
        );
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'alibaba-token-plan', order: 32, label: () => t('title') },
            UsageSettings,
          ),
        );
      },
    };
  },
});