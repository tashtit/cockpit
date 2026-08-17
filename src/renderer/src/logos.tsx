import type { JSX } from 'react'
import type { PrStatus, Provider } from '../../shared/types'

export const PROVIDER_LABEL: Record<Provider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  copilot: 'Copilot'
}

/* Official brand marks:
 *  - Claude: Anthropic starburst (Simple Icons path data)
 *  - Codex: OpenAI blossom (one petal from the official geometry, rotated ×6)
 *  - Copilot: GitHub Copilot icon (Simple Icons path data)
 * Rendered in currentColor so the provider palette carries through. */
const CLAUDE_PATH =
  'm4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z'

const OPENAI_PETAL =
  'M1107.3 299.1c-197.999 0-373.9 127.3-435.2 315.3L650 743.5v427.9c0 21.4 11 40.4 29.4 51.4l344.5 198.515V833.3h.1v-27.9L1372.7 604c33.715-19.52 70.44-32.857 108.47-39.828L1447.6 450.3C1361 353.5 1237.1 298.5 1107.3 299.1zm0 117.5-.6.6c79.699 0 156.3 27.5 217.6 78.4-2.5 1.2-7.4 4.3-11 6.1L952.8 709.3c-18.4 10.4-29.4 30-29.4 51.4V1248l-155.1-89.4V755.8c-.1-187.099 151.601-338.9 339-339.2z'

const COPILOT_PATH =
  'M23.922 16.997C23.061 18.492 18.063 22.02 12 22.02 5.937 22.02.939 18.492.078 16.997A.641.641 0 0 1 0 16.741v-2.869a.883.883 0 0 1 .053-.22c.372-.935 1.347-2.292 2.605-2.656.167-.429.414-1.055.644-1.517a10.098 10.098 0 0 1-.052-1.086c0-1.331.282-2.499 1.132-3.368.397-.406.89-.717 1.474-.952C7.255 2.937 9.248 1.98 11.978 1.98c2.731 0 4.767.957 6.166 2.093.584.235 1.077.546 1.474.952.85.869 1.132 2.037 1.132 3.368 0 .368-.014.733-.052 1.086.23.462.477 1.088.644 1.517 1.258.364 2.233 1.721 2.605 2.656a.841.841 0 0 1 .053.22v2.869a.641.641 0 0 1-.078.256Zm-11.75-5.992h-.344a4.359 4.359 0 0 1-.355.508c-.77.947-1.918 1.492-3.508 1.492-1.725 0-2.989-.359-3.782-1.259a2.137 2.137 0 0 1-.085-.104L4 11.746v6.585c1.435.779 4.514 2.179 8 2.179 3.486 0 6.565-1.4 8-2.179v-6.585l-.098-.104s-.033.045-.085.104c-.793.9-2.057 1.259-3.782 1.259-1.59 0-2.738-.545-3.508-1.492a4.359 4.359 0 0 1-.355-.508Zm2.328 3.25c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm-5 0c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm3.313-6.185c.136 1.057.403 1.913.878 2.497.442.544 1.134.938 2.344.938 1.573 0 2.292-.337 2.657-.751.384-.435.558-1.15.558-2.361 0-1.14-.243-1.847-.705-2.319-.477-.488-1.319-.862-2.824-1.025-1.487-.161-2.192.138-2.533.529-.269.307-.437.808-.438 1.578v.021c0 .265.021.562.063.893Zm-1.626 0c.042-.331.063-.628.063-.894v-.02c-.001-.77-.169-1.271-.438-1.578-.341-.391-1.046-.69-2.533-.529-1.505.163-2.347.537-2.824 1.025-.462.472-.705 1.179-.705 2.319 0 1.211.175 1.926.558 2.361.365.414 1.084.751 2.657.751 1.21 0 1.902-.394 2.344-.938.475-.584.742-1.44.878-2.497Z'

/* Decorative marks: every usage sits next to a text label, an aria-label, or a
 * titled wrapper — aria-hidden avoids double announcements ("Claude Claude"). */
export function ProviderLogo({ p, size = 14 }: { p: Provider; size?: number }): JSX.Element {
  if (p === 'claude') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className="logo-claude" aria-hidden="true">
        <path fill="currentColor" d={CLAUDE_PATH} />
      </svg>
    )
  }
  if (p === 'codex') {
    return (
      <svg width={size} height={size} viewBox="0 0 2406 2406" className="logo-codex" aria-hidden="true">
        {[0, 60, 120, 180, 240, 300].map((deg) => (
          <path
            key={deg}
            fill="currentColor"
            d={OPENAI_PETAL}
            transform={deg === 0 ? undefined : `rotate(${deg} 1203 1203)`}
          />
        ))}
      </svg>
    )
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="logo-copilot" aria-hidden="true">
      <path fill="currentColor" d={COPILOT_PATH} />
    </svg>
  )
}

import cockpitLogoUrl from './assets/cockpit-logo.webp'

/** The user-supplied Cockpit mark, used exactly as provided (no redrawing).
 *  Decorative: it always appears beside the "Cockpit" wordmark or a heading. */
export function CockpitLogo({ size = 18 }: { size?: number }): JSX.Element {
  return (
    <img
      src={cockpitLogoUrl}
      width={size}
      height={size}
      alt=""
      className="logo-cockpit"
      draggable={false}
    />
  )
}

/* GitHub Octicons (MIT) */
const OCTICON_REPO =
  'M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z'
const OCTICON_BRANCH =
  'M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z'
const OCTICON_PR =
  'M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z'
const OCTICON_MERGE =
  'M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM3.5 3.25a.75.75 0 1 1 1.5 0 .75.75 0 0 1-1.5 0Z'

function Octicon({ d, size = 14 }: { d: string; size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

const OCTICON_ORG =
  'M1.75 16A1.75 1.75 0 0 1 0 14.25V1.75C0 .784.784 0 1.75 0h8.5C11.216 0 12 .784 12 1.75v12.5c0 .085-.006.168-.018.25h2.268a.25.25 0 0 0 .25-.25V8.285a.25.25 0 0 0-.111-.208l-1.055-.703a.749.749 0 1 1 .832-1.248l1.055.703c.487.325.779.871.779 1.456v5.965A1.75 1.75 0 0 1 14.25 16h-3.5a.766.766 0 0 1-.197-.026c-.099.017-.2.026-.303.026h-3a.75.75 0 0 1-.75-.75V14h-1v1.25a.75.75 0 0 1-.75.75Zm-.25-1.75c0 .138.112.25.25.25H4v-1.25a.75.75 0 0 1 .75-.75h2.5a.75.75 0 0 1 .75.75v1.25h2.25a.25.25 0 0 0 .25-.25V1.75a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25ZM3.75 6h.5a.75.75 0 0 1 0 1.5h-.5a.75.75 0 0 1 0-1.5ZM3 3.75A.75.75 0 0 1 3.75 3h.5a.75.75 0 0 1 0 1.5h-.5A.75.75 0 0 1 3 3.75Zm4 3A.75.75 0 0 1 7.75 6h.5a.75.75 0 0 1 0 1.5h-.5A.75.75 0 0 1 7 6.75ZM7.75 3h.5a.75.75 0 0 1 0 1.5h-.5a.75.75 0 0 1 0-1.5ZM3 9.75A.75.75 0 0 1 3.75 9h.5a.75.75 0 0 1 0 1.5h-.5A.75.75 0 0 1 3 9.75ZM7.75 9h.5a.75.75 0 0 1 0 1.5h-.5a.75.75 0 0 1 0-1.5Z'

const OCTICON_COMMENT_DISCUSSION =
  'M1.75 1h8.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 10.25 10H7.061l-2.574 2.573A1.458 1.458 0 0 1 2 11.543V10h-.25A1.75 1.75 0 0 1 0 8.25v-5.5C0 1.784.784 1 1.75 1ZM1.5 2.75v5.5c0 .138.112.25.25.25h1a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h3.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25Zm13 2a.25.25 0 0 0-.25-.25h-.5a.75.75 0 0 1 0-1.5h.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 14.25 12H14v1.543a1.458 1.458 0 0 1-2.487 1.03L9.22 12.28a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215l2.22 2.22v-2.19a.75.75 0 0 1 .75-.75h1a.25.25 0 0 0 .25-.25Z'

export const RepoIcon = ({ size = 14 }: { size?: number }): JSX.Element => (
  <Octicon d={OCTICON_REPO} size={size} />
)
export const OrgIcon = ({ size = 13 }: { size?: number }): JSX.Element => (
  <Octicon d={OCTICON_ORG} size={size} />
)
export const ChatIcon = ({ size = 13 }: { size?: number }): JSX.Element => (
  <Octicon d={OCTICON_COMMENT_DISCUSSION} size={size} />
)

/* Two server bays with an indicator LED each (hand-drawn, octicon-sized). The LED
 * subpaths punch holes out of the bays via evenodd — keep that fill rule. */
const ENDPOINT_PATH =
  'M1.75 2.5h12.5c.69 0 1.25.56 1.25 1.25v1.5c0 .69-.56 1.25-1.25 1.25H1.75C1.06 6.5.5 5.94.5 5.25v-1.5C.5 3.06 1.06 2.5 1.75 2.5Zm1.5 2.75a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM1.75 9.5h12.5c.69 0 1.25.56 1.25 1.25v1.5c0 .69-.56 1.25-1.25 1.25H1.75c-.69 0-1.25-.56-1.25-1.25v-1.5c0-.69.56-1.25 1.25-1.25Zm1.5 2.75a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z'

/** Custom model endpoint mark (Settings rows). Decorative — always beside a label. */
export const EndpointIcon = ({ size = 13 }: { size?: number }): JSX.Element => (
  <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
    <path d={ENDPOINT_PATH} fill="currentColor" fillRule="evenodd" />
  </svg>
)

/* Octicon gear (Settings) and graph (Profile) — shared by the sidebar nav and the
 * ⌘K palette so the two surfaces can never drift apart. */
const OCTICON_GEAR =
  'M8 0a8.2 8.2 0 0 1 .701.031C9.444.095 9.99.645 10.16 1.29l.288 1.107c.018.066.079.158.212.224.231.114.454.243.668.386.123.082.233.09.299.071l1.103-.303c.644-.176 1.392.021 1.82.63.27.385.506.792.704 1.218.315.675.111 1.422-.364 1.891l-.814.806c-.049.048-.098.147-.088.294a6.214 6.214 0 0 1 0 .772c-.01.147.038.246.088.294l.814.806c.475.469.679 1.216.364 1.891a7.977 7.977 0 0 1-.704 1.217c-.428.61-1.176.807-1.82.63l-1.102-.302c-.067-.019-.177-.011-.3.071a5.909 5.909 0 0 1-.668.386c-.133.066-.194.158-.211.224l-.29 1.106c-.168.646-.715 1.196-1.458 1.26a8.006 8.006 0 0 1-1.402 0c-.743-.064-1.289-.614-1.458-1.26l-.289-1.106c-.018-.066-.079-.158-.212-.224a5.738 5.738 0 0 1-.668-.386c-.123-.082-.233-.09-.299-.071l-1.103.303c-.644.176-1.392-.021-1.82-.63a8.12 8.12 0 0 1-.704-1.218c-.315-.675-.111-1.422.363-1.891l.815-.806c.05-.048.098-.147.088-.294a6.214 6.214 0 0 1 0-.772c.01-.147-.038-.246-.088-.294l-.815-.806C.635 6.045.431 5.298.746 4.623a7.92 7.92 0 0 1 .704-1.217c.428-.61 1.176-.807 1.82-.63l1.102.302c.067.019.177.011.3-.071.214-.143.437-.272.668-.386.133-.066.194-.158.211-.224l.29-1.106C6.009.645 6.556.095 7.299.03 7.53.01 7.764 0 8 0Zm-.571 1.525c-.036.003-.108.036-.137.146l-.289 1.105c-.147.561-.549.967-.998 1.189-.173.086-.34.183-.5.29-.417.278-.97.423-1.529.27l-1.103-.303c-.109-.03-.175.016-.195.045-.22.312-.412.644-.573.99-.014.031-.021.11.059.19l.815.806c.411.406.562.957.53 1.456a4.709 4.709 0 0 0 0 .582c.032.499-.119 1.05-.53 1.456l-.815.806c-.081.08-.073.159-.059.19.162.346.353.677.573.989.02.03.085.076.195.046l1.102-.303c.56-.153 1.113-.008 1.53.27.161.107.328.204.501.29.447.222.85.629.997 1.189l.289 1.105c.029.109.101.143.137.146a6.6 6.6 0 0 0 1.142 0c.036-.003.108-.036.137-.146l.289-1.105c.147-.561.549-.967.998-1.189.173-.086.34-.183.5-.29.417-.278.97-.423 1.529-.27l1.103.303c.109.029.175-.016.195-.045.22-.313.411-.644.573-.99.014-.031.021-.11-.059-.19l-.815-.806c-.411-.406-.562-.957-.53-1.456a4.709 4.709 0 0 0 0-.582c-.032-.499.119-1.05.53-1.456l.815-.806c.081-.08.073-.159.059-.19a6.464 6.464 0 0 0-.573-.989c-.02-.03-.085-.076-.195-.046l-1.102.303c-.56.153-1.113.008-1.53-.27a4.44 4.44 0 0 0-.501-.29c-.447-.222-.85-.629-.997-1.189l-.289-1.105c-.029-.11-.101-.143-.137-.146a6.6 6.6 0 0 0-1.142 0ZM11 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM9.5 8a1.5 1.5 0 1 0-3.001.001A1.5 1.5 0 0 0 9.5 8Z'
const OCTICON_GRAPH =
  'M1.5 1.75a.75.75 0 0 0-1.5 0v12.5c0 .414.336.75.75.75h14.5a.75.75 0 0 0 0-1.5H1.5V1.75Zm14.28 2.53a.75.75 0 0 0-1.06-1.06L10 7.94 7.53 5.47a.75.75 0 0 0-1.06 0L3.22 8.72a.75.75 0 0 0 1.06 1.06L7 7.06l2.47 2.47a.75.75 0 0 0 1.06 0l5.25-5.25Z'

export const GearIcon = ({ size = 16 }: { size?: number }): JSX.Element => (
  <Octicon d={OCTICON_GEAR} size={size} />
)
export const GraphIcon = ({ size = 16 }: { size?: number }): JSX.Element => (
  <Octicon d={OCTICON_GRAPH} size={size} />
)

/* Agent head (hand-drawn, octicon-sized, like EndpointIcon): antenna + hollow head
 * ring + two eyes. The ring punches its interior out via evenodd; antenna and eyes
 * live in a second plain path so overlapping subpaths can't punch holes in each other. */
const AGENT_HEAD_RING =
  'M3 4.5h10a2 2 0 0 1 2 2v5.5a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2Zm.25 1.5a.75.75 0 0 0-.75.75v4.75c0 .414.336.75.75.75h9.5a.75.75 0 0 0 .75-.75V6.75a.75.75 0 0 0-.75-.75h-9.5Z'
const AGENT_FACE =
  'M8 .9a1 1 0 0 1 .6 1.8l-.001 1.05h-1.2V2.7A1 1 0 0 1 8 .9ZM5.5 9a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm5 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z'

/** Agents view mark (shared setup every agent carries). Decorative — always beside a label. */
export const AgentIcon = ({ size = 16 }: { size?: number }): JSX.Element => (
  <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
    <path d={AGENT_HEAD_RING} fill="currentColor" fillRule="evenodd" />
    <path d={AGENT_FACE} fill="currentColor" />
  </svg>
)

const OCTICON_LINK_EXTERNAL =
  'M3.75 2h3.5a.75.75 0 0 1 0 1.5h-3.5a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-3.5a.75.75 0 0 1 1.5 0v3.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5C2 2.784 2.784 2 3.75 2Zm6.854-1h4.146a.25.25 0 0 1 .25.25v4.146a.25.25 0 0 1-.427.177L13.03 4.03 9.28 7.78a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042l3.75-3.75-1.543-1.543A.25.25 0 0 1 10.604 1Z'

export const LinkExternalIcon = ({ size = 11 }: { size?: number }): JSX.Element => (
  <Octicon d={OCTICON_LINK_EXTERNAL} size={size} />
)
export const BranchIcon = ({ size = 12 }: { size?: number }): JSX.Element => (
  <Octicon d={OCTICON_BRANCH} size={size} />
)

/** Live-status dot: this session's agent is running right now. Color = agent identity. */
export function LiveDot({ p }: { p: Provider }): JSX.Element {
  const label = `${PROVIDER_LABEL[p]} is working`
  return <span className={`pulse pulse-${p}`} role="img" aria-label={label} title={label} />
}

/**
 * Branch pill. Cockpit worktree branches all share the `cockpit/` prefix, so it
 * carries no information — abbreviate it to a dimmed `c/` and spend the chip's
 * width on the part that distinguishes branches. Full name stays in the tooltip.
 */
export function BranchChip({ branch }: { branch: string }): JSX.Element {
  const suffix = branch.startsWith('cockpit/') ? branch.slice('cockpit/'.length) : null
  return (
    <span className="branch-chip" title={`⎇ ${branch}`}>
      <BranchIcon size={10} />
      <span className="chip-text">
        {suffix !== null ? (
          <>
            <span className="chip-pre">c/</span>
            {suffix}
          </>
        ) : (
          branch
        )}
      </span>
    </span>
  )
}

export function PrBadge({
  pr,
  onOpen,
  compact = false
}: {
  pr: PrStatus
  onOpen: (url: string) => void
  compact?: boolean
}): JSX.Element {
  const cls = pr.state === 'OPEN' ? (pr.isDraft ? 'draft' : 'open') : pr.state.toLowerCase()
  const label =
    pr.state === 'MERGED' ? 'Merged' : pr.state === 'CLOSED' ? 'Closed' : pr.isDraft ? 'Draft' : 'Open'
  return (
    <button
      className={`pr-badge pr-${cls} ${compact ? 'compact' : ''}`}
      // the compact badge renders only "#42" — state lives in the border color alone,
      // so it has to be in the name too (WCAG 1.4.1)
      aria-label={`${label} pull request #${pr.number}: ${pr.title}`}
      title={`${label} — #${pr.number} ${pr.title}`}
      onClick={(e) => {
        e.stopPropagation()
        onOpen(pr.url)
      }}
    >
      <Octicon d={pr.state === 'MERGED' ? OCTICON_MERGE : OCTICON_PR} size={compact ? 10 : 11} />
      {compact ? `#${pr.number}` : `${label} #${pr.number}`}
    </button>
  )
}
