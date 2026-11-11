// The display preferences on the Appearance page, below the theme picker. They live in this window, not the garage.
import { useState } from 'react'
import { Button, CHAT_NOUN, GROUP, Hint, Switch } from '../controls.tsx'
import { showPaths, usePathsShown } from '../paths.ts'
import {
  askNotificationLeave,
  notificationsAllowed,
  setNotificationPref,
  useNotificationPrefs,
  type NotifyKind,
} from '../notifications.ts'
import { showReportsByDefault, showStepsByDefault, useReportsDefault, useStepsDefault } from '../steps.ts'
import { Appearance } from '../themes.tsx'
import { SettingRow } from './rows.tsx'

function ShownPaths() {
  const paths = usePathsShown()
  return (
    <>
      <div className="pt-24 pb-8 font-semibold">File paths</div>
      <div className={GROUP}>
        <SettingRow name="At the top of a space">
          <Switch label="Show paths at the top of a space" checked={paths.header} onChange={(on) => showPaths('header', on)} />
        </SettingRow>
        <SettingRow name="In the Context panel">
          <Switch label="Show paths in the Context panel" checked={paths.context} onChange={(on) => showPaths('context', on)} />
        </SettingRow>
      </div>
    </>
  )
}

function ShownSteps() {
  const shown = useStepsDefault()
  return (
    <>
      <div className="pt-24 pb-8 font-semibold">Thinking and tool calls</div>
      <div className={GROUP}>
        <SettingRow
          name="Show unfolded"
          description={`Instead of folding them into "N steps". Each ${CHAT_NOUN.one} can override this in its Context panel.`}
        >
          <Switch label="Show thinking and tool calls unfolded" checked={shown} onChange={showStepsByDefault} />
        </SettingRow>
      </div>
    </>
  )
}

function ShownReports() {
  const shown = useReportsDefault()
  return (
    <>
      <div className="pt-24 pb-8 font-semibold">Worker reports</div>
      <div className={GROUP}>
        <SettingRow
          name="Show unfolded"
          description={`Folded, a report shows one line until opened. Each ${CHAT_NOUN.one} can override this in its General tab.`}
        >
          <Switch label="Show worker reports unfolded" checked={shown} onChange={showReportsByDefault} />
        </SettingRow>
      </div>
    </>
  )
}

const NOTIFY_KINDS: { kind: NotifyKind; name: string; hint: string }[] = [
  { kind: 'needsYou', name: 'Needs you', hint: 'A permission request, a question, or an extension waiting on you' },
  { kind: 'finished', name: 'Finished', hint: `A ${CHAT_NOUN.one} or Home finished a turn. Workers report to their ${CHAT_NOUN.one} instead.` },
  { kind: 'errors', name: 'Errors', hint: 'A turn ended with an error, a worker\'s too' },
]

const NOTIFY_HINT = `Only while you aren't looking at that ${CHAT_NOUN.one}. With Kothar in front, only what needs you or failed in another ${CHAT_NOUN.one} shows. Several at once show as one; clicking it opens the ${CHAT_NOUN.one}.`

function Notifications() {
  const prefs = useNotificationPrefs()
  // In a browser tab (development), the browser asks before a page may notify.
  const [allowed, setAllowed] = useState(notificationsAllowed)
  const allow = async () => setAllowed((await askNotificationLeave()) === 'granted')
  return (
    <>
      <div className="flex items-center gap-6 pt-24 pb-8 font-semibold">
        <Hint text={NOTIFY_HINT}>
          <span>Notifications</span>
        </Hint>
      </div>
      <div className={GROUP}>
        <SettingRow name="Show notifications">
          {prefs.enabled && !allowed && (
            <Button size="small" onClick={() => void allow()}>
              Allow in this browser
            </Button>
          )}
          <Switch label="Show notifications" checked={prefs.enabled} onChange={(on) => setNotificationPref('enabled', on)} />
        </SettingRow>
        {NOTIFY_KINDS.map(({ kind, name, hint }) => (
          <SettingRow
            key={kind}
            name={
              <Hint text={hint}>
                <span className="self-start">{name}</span>
              </Hint>
            }
          >
            <Switch
              label={`Notify: ${name}`}
              checked={prefs[kind]}
              disabled={!prefs.enabled}
              onChange={(on) => setNotificationPref(kind, on)}
            />
          </SettingRow>
        ))}
      </div>
    </>
  )
}

// Everything under Settings → Appearance: the theme picker, then the display preferences above.
export function AppearancePage({ openMarketplace }: { openMarketplace?: () => void }) {
  return (
    <>
      <Appearance browse={openMarketplace} />
      <ShownPaths />
      <ShownSteps />
      <ShownReports />
      <Notifications />
    </>
  )
}
