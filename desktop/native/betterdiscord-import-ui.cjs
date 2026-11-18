// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';

// The pinned renderer supplies its own React, button, and theme library.
// Keep this factory self-contained so it can also be used in a source build.
function createBetterDiscordImport({React, jsx, jsxs, Button, converter, getLocale, saveTheme, getOrigin, resolveWallpaper}) {
  const {useEffect, useId, useRef, useState} = React;
  const {
    parseBetterDiscordTheme, buildImportedTheme, resolveImportWallpaper,
    prepareThemeWallpaper, panelBackground, MAX_THEME_BYTES,
  } = converter;

  const messages = {
    en: {
      title: 'Import a BetterDiscord theme',
      file: 'Choose a theme file (.css, up to 1 MiB)',
      paste: 'Paste theme CSS',
      analyse: 'Preview theme',
      preview: 'Theme preview',
      channels: 'Channels',
      general: 'General',
      sample: 'Messages will look like this.',
      opacity: 'Panel opacity',
      dimming: 'Wallpaper dimming',
      blur: 'Panel blur',
      image: 'Choose wallpaper (PNG, JPEG, WebP or GIF)',
      removeImage: 'Remove wallpaper',
      retryImage: 'Retry wallpaper download',
      loadingImage: 'Preparing wallpaper…',
      imageError: 'Could not load the wallpaper. Choose an image file to use instead.',
      saving: 'Saving theme…',
      fileError: 'Choose a non-empty CSS file up to 1 MiB.',
      parseError: 'Could not read the CSS. Check the theme file and try again.',
      saveError: 'Could not finish importing this theme. Check your theme library and try again.',
      save: 'Save theme',
      apply: 'Apply after saving',
      saved: 'Theme saved in your library.',
      applied: 'Theme saved and enabled.',
      savedWithoutApply: 'Theme saved. Enable it in your theme library.',
      limitations: 'The preview adapts recognized colors and backgrounds. Discord layout and remote CSS imports are skipped.',
      counts: 'Skipped rules / remote imports',
    },
    ru: {
      title: 'Импорт темы BetterDiscord',
      file: 'Выбрать файл темы (.css, до 1 МиБ)',
      paste: 'Вставить CSS темы',
      analyse: 'Предпросмотр темы',
      preview: 'Предпросмотр темы',
      channels: 'Каналы',
      general: 'Общий',
      sample: 'Так будут выглядеть сообщения.',
      opacity: 'Непрозрачность панелей',
      dimming: 'Затемнение фона',
      blur: 'Размытие панелей',
      image: 'Выбрать фон (PNG, JPEG, WebP или GIF)',
      removeImage: 'Убрать фон',
      retryImage: 'Повторить загрузку фона',
      loadingImage: 'Подготовка фона…',
      imageError: 'Не удалось загрузить фон. Можно выбрать изображение с компьютера.',
      saving: 'Сохранение темы…',
      fileError: 'Выбери непустой CSS-файл размером до 1 МиБ.',
      parseError: 'Не удалось прочитать CSS. Проверь файл темы и попробуй ещё раз.',
      saveError: 'Не удалось завершить импорт. Проверь библиотеку тем и попробуй ещё раз.',
      save: 'Сохранить тему',
      apply: 'Применить после сохранения',
      saved: 'Тема сохранена в библиотеке.',
      applied: 'Тема сохранена и включена.',
      savedWithoutApply: 'Тема сохранена. Включи её в библиотеке тем.',
      limitations: 'Предпросмотр использует распознанные цвета и фон. Разметка Discord и удалённые CSS-импорты пропускаются.',
      counts: 'Пропущенные правила / удалённые импорты',
    },
    uk: {
      title: 'Імпорт теми BetterDiscord',
      file: 'Вибрати файл теми (.css, до 1 МіБ)',
      paste: 'Вставити CSS теми',
      analyse: 'Перегляд теми',
      preview: 'Попередній перегляд теми',
      channels: 'Канали',
      general: 'Загальний',
      sample: 'Так виглядатимуть повідомлення.',
      opacity: 'Непрозорість панелей',
      dimming: 'Затемнення тла',
      blur: 'Розмиття панелей',
      image: 'Вибрати тло (PNG, JPEG, WebP або GIF)',
      removeImage: 'Прибрати тло',
      retryImage: 'Повторити завантаження тла',
      loadingImage: 'Підготовка тла…',
      imageError: 'Не вдалося завантажити тло. Можна вибрати зображення з комп’ютера.',
      saving: 'Збереження теми…',
      fileError: 'Вибери непорожній CSS-файл розміром до 1 МіБ.',
      parseError: 'Не вдалося прочитати CSS. Перевір файл теми та спробуй ще раз.',
      saveError: 'Не вдалося завершити імпорт. Перевір бібліотеку тем і спробуй ще раз.',
      save: 'Зберегти тему',
      apply: 'Застосувати після збереження',
      saved: 'Тему збережено у бібліотеці.',
      applied: 'Тему збережено й увімкнено.',
      savedWithoutApply: 'Тему збережено. Увімкни її у бібліотеці тем.',
      limitations: 'Попередній перегляд використовує розпізнані кольори й тло. Розмітка Discord і віддалені CSS-імпорти пропускаються.',
      counts: 'Пропущені правила / віддалені імпорти',
    },
  };

  const panelStyle = {
    border: '1px solid var(--background-modifier-accent, #43434b)',
    borderRadius: 8,
    padding: 12,
    minWidth: 0,
  };
  const column = {display: 'grid', gap: 10, minWidth: 0};
  const row = {display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8};
  const muted = {margin: 0, color: 'var(--text-secondary)', fontSize: 13};
  const cursor = {cursor: 'pointer', fontWeight: 600};
  const field = {display: 'grid', gap: 4, minWidth: 0, fontSize: 13};

  function embeddedWallpaper(value) {
    return typeof value === 'string' && value.length <= MAX_THEME_BYTES && value.startsWith('data:')
      ? resolveImportWallpaper(value, getOrigin())
      : null;
  }

  function Preview({draft, copy}) {
    const {settings, wallpaper} = draft;
    const surfaces = settings.appearance ?? {};
    const shade = `rgb(from ${surfaces.overlay ?? '#000'} r g b / ${settings.dimming})`;
    const image = wallpaper ? `linear-gradient(${shade}, ${shade}), url(${JSON.stringify(wallpaper)})` : undefined;
    const blur = `blur(${settings.blur}px)`;
    return jsxs('div', {
      role: 'img',
      'aria-label': copy.preview,
      style: {
        display: 'grid', gridTemplateColumns: 'minmax(78px, 28%) minmax(0, 1fr)', minHeight: 126,
        borderRadius: 8, border: '1px solid var(--background-modifier-accent, #43434b)', overflow: 'hidden',
        backgroundColor: '#161822', backgroundImage: image, backgroundSize: 'cover', backgroundPosition: 'center',
        color: settings.text, fontFamily: settings.font, fontSize: 13,
      },
      children: [
        jsxs('div', {
          style: {
            padding: 10,
            background: panelBackground(surfaces.sidebar ?? '#000', settings.opacity),
            backdropFilter: blur,
          },
          children: [
            jsx('div', {style: {color: settings.muted}, children: copy.channels}),
            jsx('div', {
              style: {
                marginTop: 6, padding: '4px 6px', borderRadius: 4, overflowWrap: 'anywhere',
                background: surfaces.selected ?? `color-mix(in srgb, ${settings.accent} 35%, transparent)`,
              },
              children: `# ${copy.general}`,
            }),
          ],
        }),
        jsxs('div', {
          style: {padding: 10, background: surfaces.chat ?? 'transparent'},
          children: [
            jsx('strong', {style: {overflowWrap: 'anywhere'}, children: settings.name}),
            jsx('p', {style: {margin: '8px 0'}, children: copy.sample}),
            jsx('span', {
              style: {
                display: 'inline-block', borderRadius: 4, padding: '4px 8px', background: settings.accent,
                color: surfaces.buttonText ?? '#fff',
              },
              children: copy.general,
            }),
          ],
        }),
      ],
    });
  }

  function BetterDiscordImport({target}) {
    const language = String(getLocale()).toLowerCase().split(/[-_]/, 1)[0];
    const copy = messages[language] ?? messages.en;
    const id = useId();
    const operation = useRef(null);
    const mounted = useRef(false);
    const [source, setSource] = useState('');
    const [draft, setDraft] = useState(null);
    const [error, setError] = useState(null);
    const [wallpaperError, setWallpaperError] = useState(false);
    const [phase, setPhase] = useState(null);
    const [apply, setApply] = useState(false);
    const [saved, setSaved] = useState(null);
    const busy = phase !== null;

    useEffect(() => {
      mounted.current = true;
      return () => {
        mounted.current = false;
        operation.current?.abort();
        operation.current = null;
      };
    }, []);

    const perform = async (nextPhase, action, errorKey) => {
      if (operation.current) return;
      const controller = new AbortController();
      const isCurrent = () => mounted.current && operation.current === controller && !controller.signal.aborted;
      operation.current = controller;
      setPhase(nextPhase);
      setError(null);
      try {
        await action(controller.signal, isCurrent);
      } catch {
        if (isCurrent()) setError(errorKey);
      } finally {
        if (operation.current === controller) {
          operation.current = null;
          if (mounted.current) setPhase(null);
        }
      }
    };

    const downloadWallpaper = async (parsed, signal, isCurrent) => {
      setPhase('wallpaper');
      setWallpaperError(false);
      let wallpaper = null;
      try {
        wallpaper = embeddedWallpaper(await resolveWallpaper(parsed.settings.wallpaper, signal));
      } catch {
        // Keep the converted theme available with a local image fallback.
      }
      if (!isCurrent()) return;
      if (wallpaper) setDraft({...parsed, wallpaper});
      else setWallpaperError(true);
    };

    const analyse = async (css, fileName, signal, isCurrent) => {
      if (!isCurrent()) return;
      setDraft(null);
      setSaved(null);
      setWallpaperError(false);
      if (!css.trim() || new TextEncoder().encode(css).byteLength > MAX_THEME_BYTES) {
        setError('fileError');
        return;
      }
      const settings = parseBetterDiscordTheme(css, fileName);
      const wallpaper = embeddedWallpaper(settings.wallpaper);
      const parsed = {fileName, settings, wallpaper};
      setDraft(parsed);
      if (settings.wallpaper && !wallpaper) await downloadWallpaper(parsed, signal, isCurrent);
    };

    const loadTheme = event => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = '';
      if (!file || operation.current) return;
      if (!/\.css$/i.test(file.name) || !file.size || file.size > MAX_THEME_BYTES) {
        setError('fileError');
        return;
      }
      void perform('read', async (signal, isCurrent) => {
        const css = await file.text();
        if (!isCurrent()) return;
        setSource(css);
        await analyse(css, file.name, signal, isCurrent);
      }, 'parseError');
    };

    const loadImage = event => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = '';
      if (!file || !draft) return;
      void perform('wallpaper', async (_signal, isCurrent) => {
        const wallpaper = embeddedWallpaper(await prepareThemeWallpaper(file));
        if (!isCurrent()) return;
        if (!wallpaper) throw new Error('Invalid embedded wallpaper');
        setDraft({...draft, wallpaper});
        setWallpaperError(false);
      }, 'imageError');
    };

    const save = () => {
      if (!draft || saved) return;
      void perform('save', async (_signal, isCurrent) => {
        const css = buildImportedTheme(draft.settings, draft.wallpaper, getOrigin());
        const base = draft.fileName.replace(/(?:\.theme)?\.css$/i, '').slice(0, 140);
        const result = await saveTheme({css, fileName: `${base || 'imported'}-DxD.theme.css`, target, apply});
        if (!isCurrent()) return;
        setSaved(apply ? (result.applied ? 'applied' : 'savedWithoutApply') : 'saved');
      }, 'saveError');
    };

    const slider = (key, limit, units) => {
      const value = Math.round(draft.settings[key] * units);
      return jsxs('label', {
        style: field,
        children: [
          `${copy[key]} (${value}${units === 100 ? '%' : ' px'})`,
          jsx('input', {
            type: 'range', min: 0, max: limit, step: 1, value, disabled: busy || Boolean(saved),
            onChange: event => setDraft({...draft, settings: {...draft.settings, [key]: Number(event.currentTarget.value) / units}}),
          }),
        ],
      });
    };

    const button = (label, props) => jsx(Button, {type: 'button', small: true, variant: 'secondary', ...props, children: label});
    return jsxs('details', {
      style: panelStyle,
      'data-flx': 'theme-settings.betterdiscord-import',
      children: [
        jsx('summary', {style: cursor, id, children: copy.title}),
        jsxs('div', {
          style: {...column, marginTop: 12}, 'aria-labelledby': id,
          children: [
            jsxs('label', {
              style: field,
              children: [copy.file, jsx('input', {type: 'file', accept: '.css,text/css', onChange: loadTheme, disabled: busy})],
            }),
            jsxs('details', {
              children: [
                jsx('summary', {style: cursor, children: copy.paste}),
                jsx('textarea', {
                  'aria-label': copy.paste, value: source, maxLength: MAX_THEME_BYTES, disabled: busy, rows: 5,
                  style: {
                    display: 'block', width: '100%', boxSizing: 'border-box', margin: '8px 0', padding: 8,
                    background: 'var(--background-textarea, #1d1f26)', color: 'var(--text-primary)', resize: 'vertical',
                    border: '1px solid var(--background-modifier-accent, #43434b)', borderRadius: 6, fontFamily: 'monospace',
                  },
                  onChange: event => {
                    setSource(event.currentTarget.value);
                    setDraft(null);
                    setSaved(null);
                    setError(null);
                    setWallpaperError(false);
                  },
                }),
                button(copy.analyse, {
                  disabled: busy || !source.trim(),
                  onClick: () => void perform('read', (signal, isCurrent) => analyse(source, 'imported.theme.css', signal, isCurrent), 'parseError'),
                }),
              ],
            }),
            draft && jsx(Preview, {draft, copy}),
            draft && jsxs('div', {
              style: column,
              children: [
                slider('opacity', 100, 100),
                slider('dimming', 90, 100),
                slider('blur', 24, 1),
                jsxs('label', {
                  style: field,
                  children: [copy.image, jsx('input', {
                    type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', onChange: loadImage,
                    disabled: busy || Boolean(saved),
                  })],
                }),
                draft.wallpaper && jsx('div', {
                  style: row,
                  children: button(copy.removeImage, {
                    disabled: busy || Boolean(saved),
                    onClick: () => {setDraft({...draft, wallpaper: null}); setWallpaperError(false);},
                  }),
                }),
                wallpaperError && !draft.wallpaper && jsx('p', {style: muted, children: copy.imageError}),
                wallpaperError && draft.settings.wallpaper && !draft.wallpaper && jsx('div', {
                  style: row,
                  children: button(copy.retryImage, {
                    disabled: busy || Boolean(saved),
                    onClick: () => void perform('wallpaper', (signal, isCurrent) => downloadWallpaper(draft, signal, isCurrent), 'imageError'),
                  }),
                }),
                jsx('p', {style: muted, children: copy.limitations}),
                (draft.settings.ignoredRules > 0 || draft.settings.imports > 0) && jsx('p', {
                  style: muted, children: `${copy.counts} · ${draft.settings.ignoredRules} / ${draft.settings.imports}`,
                }),
                jsxs('div', {
                  style: row,
                  children: [
                    button(copy.save, {variant: 'primary', disabled: busy || Boolean(saved), onClick: save}),
                    jsxs('label', {
                      style: {...row, flexWrap: 'nowrap', fontSize: 13},
                      children: [jsx('input', {
                        type: 'checkbox', checked: apply, disabled: busy || Boolean(saved),
                        onChange: event => setApply(event.currentTarget.checked),
                      }), copy.apply],
                    }),
                  ],
                }),
              ],
            }),
            jsx('div', {
              role: 'status', style: muted,
              children: phase === 'wallpaper' ? copy.loadingImage : phase === 'save' ? copy.saving : saved ? copy[saved] : '',
            }),
            error && jsx('p', {role: 'alert', style: {margin: 0, color: 'var(--text-danger, #ff7777)'}, children: copy[error]}),
          ],
        }),
      ],
    });
  }

  return BetterDiscordImport;
}

const BETTERDISCORD_IMPORT_FACTORY_SOURCE = `(${createBetterDiscordImport.toString()})`;
module.exports = {createBetterDiscordImport, BETTERDISCORD_IMPORT_FACTORY_SOURCE};
