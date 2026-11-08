// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';

// This factory is also serialized into the pinned desktop and web renderer.
// Keep it self-contained: React, the existing UI button, and authenticated REST
// transport are supplied by each renderer rather than copied or rediscovered.
function createMusicPlayerControls({React, jsx, jsxs, Button, http, getLocale = () => 'en'}) {
  const BOT_ID = '1562471889513742336';
  const HOSTS = new Set(['darkdck.duckdns.org', 'darkdc.pp.ua']);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const SNOWFLAKE = /^[0-9]{1,20}$/;
  const ACTION_ROWS = [
    ['previous', 'back', 'toggle', 'forward', 'skip'],
    ['shuffle', 'stop', 'loop', 'voldown', 'volup'],
    ['close'],
  ];
  const ICONS = {previous: '⏮', back: '↶', toggle: '⏸', forward: '↷', skip: '⏭', shuffle: '⤨', stop: '⏹', loop: '↻', voldown: '−', volup: '+', close: '×'};
  const COPY = {
    en: {group: 'Music player controls', previous: 'Previous', back: '−20 sec', pause: 'Pause', resume: 'Resume', forward: '+20 sec', skip: 'Skip', shuffle: 'Shuffle', stop: 'Stop', loop: 'Repeat', off: 'Off', song: 'Track', queue: 'Queue', voldown: 'Volume −', volup: 'Volume +', close: 'Close player', busy: 'Applying…', failure: 'Could not control the player. Try again.', closed: 'This player is closed.'},
    ru: {group: 'Управление музыкой', previous: 'Предыдущий', back: '−20 сек', pause: 'Пауза', resume: 'Продолжить', forward: '+20 сек', skip: 'Следующий', shuffle: 'Перемешать', stop: 'Стоп', loop: 'Повтор', off: 'Выкл.', song: 'Трек', queue: 'Очередь', voldown: 'Тише', volup: 'Громче', close: 'Закрыть плеер', busy: 'Выполняется…', failure: 'Не удалось управлять плеером. Попробуйте ещё раз.', closed: 'Этот плеер закрыт.'},
    uk: {group: 'Керування музикою', previous: 'Попередній', back: '−20 с', pause: 'Пауза', resume: 'Продовжити', forward: '+20 с', skip: 'Наступний', shuffle: 'Перемішати', stop: 'Стоп', loop: 'Повтор', off: 'Вимк.', song: 'Трек', queue: 'Черга', voldown: 'Тихіше', volup: 'Гучніше', close: 'Закрити плеєр', busy: 'Виконується…', failure: 'Не вдалося керувати плеєром. Спробуйте ще раз.', closed: 'Цей плеєр закрито.'},
  };

  function parsePanel(message, channel, isPreview) {
    if (isPreview || !message || !channel || message.author?.id !== BOT_ID || message.webhookId || message.webhook_id || message.suppressEmbeds || message.blocked) return null;
    if (message.messageSnapshots?.length || message.message_snapshots?.length) return null;
    if (!SNOWFLAKE.test(message.id ?? '') || !SNOWFLAKE.test(channel.id ?? '') || !SNOWFLAKE.test(channel.guildId ?? '')) return null;
    if (message.channelId !== channel.id || (message.guildId && message.guildId !== channel.guildId)) return null;
    if (!Array.isArray(message.embeds)) return null;
    const markers = [];
    for (const embed of message.embeds) {
      if (typeof embed?.url !== 'string') continue;
      let url;
      try {url = new URL(embed.url);} catch {continue;}
      if (url.searchParams.has('dxd_player')) markers.push(url);
    }
    if (markers.length !== 1) return null;
    const url = markers[0];
    if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.port || url.username || url.password || url.hash) return null;
    if (url.pathname !== `/channels/${channel.guildId}/${channel.id}`) return null;
    const keys = ['dxd_player', 'paused', 'loop', 'closed'];
    if ([...url.searchParams.keys()].length !== keys.length || keys.some(key => url.searchParams.getAll(key).length !== 1)) return null;
    const marker = url.searchParams.get('dxd_player');
    if (!marker?.startsWith('v1.') || !UUID.test(marker.slice(3))) return null;
    const paused = url.searchParams.get('paused'), loop = url.searchParams.get('loop'), closed = url.searchParams.get('closed');
    if (!['0', '1'].includes(paused) || !['off', 'song', 'queue'].includes(loop) || !['0', '1'].includes(closed)) return null;
    return {id: marker.slice(3), paused: paused === '1', loop, closed: closed === '1'};
  }

  function MusicPlayerControls({message, channel, isPreview = false}) {
    const locale = String(getLocale() || 'en').toLowerCase().split('-')[0];
    const copy = COPY[locale] || COPY.en;
    const panel = parsePanel(message, channel, isPreview);
    const [pending, setPending] = React.useState(null);
    const [error, setError] = React.useState('');
    const [closedLocally, setClosedLocally] = React.useState(false);
    const alive = React.useRef(false), generation = React.useRef(0), locked = React.useRef(false), currentScope = React.useRef(''), closedRef = React.useRef(false);
    const scope = panel ? `${channel.guildId}:${channel.id}:${message.id}:${panel.id}` : '';
    currentScope.current = scope;
    closedRef.current = Boolean(panel?.closed || closedLocally);
    React.useEffect(() => {
      alive.current = true;
      generation.current++;
      locked.current = false;
      setPending(null);
      setError('');
      setClosedLocally(false);
      closedRef.current = Boolean(panel?.closed);
      return () => {alive.current = false; generation.current++; locked.current = false;};
    }, [scope]);
    if (!panel) return null;
    const closed = panel.closed || closedLocally;
    const perform = async action => {
      if (!alive.current || currentScope.current !== scope || locked.current || closedRef.current) return;
      locked.current = true;
      const activeGeneration = generation.current;
      setPending(action);
      setError('');
      try {
        const result = await http.post(`/musicbot/panels/${panel.id}/actions`, {
          body: {action, message_id: message.id, channel_id: channel.id, request_id: globalThis.crypto.randomUUID()},
          retries: 0,
          timeoutMs: 15_000,
        });
        if (result?.body?.ok !== true) throw {status: result?.status, body: result?.body};
        if (alive.current && generation.current === activeGeneration && currentScope.current === scope && action === 'close') {
          closedRef.current = true;
          setClosedLocally(true);
        }
      } catch (failure) {
        if (alive.current && generation.current === activeGeneration && currentScope.current === scope) {
          if (failure?.status === 410) {closedRef.current = true; setClosedLocally(true);}
          const detail = failure?.body?.error ?? failure?.body?.message;
          setError(typeof detail === 'string' && detail.trim() ? detail.slice(0, 400) : copy.failure);
        }
      } finally {
        if (alive.current && generation.current === activeGeneration && currentScope.current === scope) {
          locked.current = false;
          setPending(null);
        }
      }
    };
    return jsxs('div', {
      role: 'group', 'aria-label': copy.group, 'aria-busy': Boolean(pending),
      'data-flx': 'channel.music-player-controls',
      style: {display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8, marginBottom: 4, maxWidth: 'min(100%, 680px)'},
      children: [
        ...ACTION_ROWS.map((actions, index) => jsx('div', {
          style: {display: 'flex', flexWrap: 'wrap', gap: 6},
          'data-flx': `channel.music-player-controls.row-${index + 1}`,
          children: actions.map(action => {
            const label = action === 'toggle' ? (panel.paused ? copy.resume : copy.pause) : action === 'loop' ? `${copy.loop}: ${copy[panel.loop]}` : copy[action];
            const icon = action === 'toggle' && panel.paused ? '▶' : ICONS[action];
            return jsxs(Button, {
              type: 'button', variant: action === 'toggle' ? 'primary' : action === 'stop' ? 'danger' : 'secondary', compact: true,
              disabled: Boolean(pending) || closed, title: label, 'aria-label': label,
              'data-flx': `channel.music-player-controls.${action}`,
              style: {minWidth: 0, whiteSpace: 'nowrap'},
              onClick: event => {event?.preventDefault(); event?.stopPropagation(); return perform(action);},
              children: [jsx('span', {'aria-hidden': true, children: `${icon} `}), jsx('span', {children: label})],
            }, action);
          }),
        }, index)),
        pending ? jsx('div', {role: 'status', 'aria-live': 'polite', style: {fontSize: 12, color: 'var(--text-secondary)'}, children: copy.busy}) : null,
        error ? jsx('div', {role: 'alert', style: {fontSize: 12, color: 'var(--status-danger, #ed4245)', overflowWrap: 'anywhere'}, children: error}) : null,
        closed && !error ? jsx('div', {role: 'status', style: {fontSize: 12, color: 'var(--text-secondary)'}, children: copy.closed}) : null,
      ],
    });
  }
  MusicPlayerControls.parsePanel = parsePanel;
  return MusicPlayerControls;
}

const MUSIC_PLAYER_CONTROLS_FACTORY_SOURCE = `(${createMusicPlayerControls.toString()})`;
module.exports = {createMusicPlayerControls, MUSIC_PLAYER_CONTROLS_FACTORY_SOURCE};
