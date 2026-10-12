/**
 * 「联系支持」弹窗里的那一行渠道。
 *
 * `SupportDialog` 本身不硬编任何社群地址(渠道由调用方给),所以「产品在用的是哪条」
 * 得有一个单一出处 —— 否则报错卡、帮助菜单、设置各写一份,改地址要改三处。
 *
 * Mishh Mashh 是 Open Design 的 fork,上游的飞书中文社区、Discord 邀请链接都不是
 * 我们的社群 —— 唯一的支持渠道是 ZeroSum 的支持邮箱。
 */
import type { SupportChannel } from './SupportDialog';
import { Icon } from '../Icon';
import type { Dict } from '../../i18n/types';

/** ZeroSum 的支持邮箱,唯一的联系支持渠道。 */
export const SUPPORT_EMAIL_URL = 'mailto:devin@zerosumsolutions.com';

export function supportChannels(
  t: (key: keyof Dict) => string,
): SupportChannel[] {
  return [
    {
      id: 'email',
      name: t('chat.support.channel.email'),
      href: SUPPORT_EMAIL_URL,
      icon: <Icon name="mail" size={20} />,
    },
  ];
}
