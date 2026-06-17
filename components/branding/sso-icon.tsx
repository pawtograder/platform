import {
  BsApple,
  BsBoxArrowInRight,
  BsDiscord,
  BsGithub,
  BsGitlab,
  BsGoogle,
  BsKey,
  BsLinkedin,
  BsMicrosoft,
  BsSlack,
  BsTwitch
} from "react-icons/bs";
import type { IconType } from "react-icons";

/**
 * Registry mapping a branding `icon` key (from a configured SSO provider) to a
 * react-icons component. Keep keys lowercase and stable — deployments reference
 * them by name in `web.branding.ssoProviders[].icon`. Unknown / unset keys fall
 * back to a generic "sign in" icon.
 */
const SSO_ICONS: Record<string, IconType> = {
  microsoft: BsMicrosoft,
  azure: BsMicrosoft,
  github: BsGithub,
  google: BsGoogle,
  apple: BsApple,
  discord: BsDiscord,
  gitlab: BsGitlab,
  slack: BsSlack,
  twitch: BsTwitch,
  linkedin: BsLinkedin,
  sso: BsKey,
  generic: BsBoxArrowInRight
};

/**
 * Renders the icon for a configured SSO provider by its branding `icon` key,
 * falling back to a generic "sign in" glyph for unknown/unset keys.
 */
export default function SsoIcon({ name }: { name?: string }) {
  const Icon = (name && SSO_ICONS[name.toLowerCase()]) || BsBoxArrowInRight;
  return <Icon aria-hidden />;
}
