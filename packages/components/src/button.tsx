import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, MouseEvent } from 'react';

import { joinClassNames } from './class-names';
import styles from './button.module.css';
import { Spinner } from './spinner';

export type ButtonVariant = 'default' | 'primary' | 'primary-ghost' | 'ghost' | 'subtle' | 'secondary';
export type ButtonSize = 'default' | 'icon' | 'sm';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /**
   * Busy state: keeps the button's width and variant colors, swaps the label
   * for a spinner, sets `aria-busy`, and swallows clicks until it clears.
   */
  loading?: boolean;
}

const variantClassNames: Record<ButtonVariant, string | undefined> = {
  default: undefined,
  primary: joinClassNames(styles.primary, 'primary'),
  'primary-ghost': joinClassNames(styles.primaryGhost, 'primary-ghost'),
  ghost: joinClassNames(styles.ghost, 'ghost'),
  subtle: joinClassNames(styles.subtle, 'subtle'),
  // chat 设计稿的 .btn.mod-secondary:白底细描边,hover 只加深描边与字色。
  // 不挂旧的全局兼容类 —— 新变体不再扩散裸 primitive 类名。
  secondary: styles.secondary,
};

const sizeClassNames: Record<ButtonSize, string | undefined> = {
  default: undefined,
  icon: joinClassNames(styles.icon, 'icon-btn'),
  // chat 设计稿的 .btn.mod-sm:26px 高、12px/600、胶囊角。设计稿里 chat 面板
  // 全部 28 个按钮都是这一档,没有一个用默认尺寸。
  sm: styles.sm,
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, type = 'button', variant = 'default', size = 'default', loading = false, onClick, children, ...props },
  ref,
) {
  const handleClick = loading
    ? (event: MouseEvent<HTMLButtonElement>) => event.preventDefault()
    : onClick;
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      className={joinClassNames(
        styles.button,
        variantClassNames[variant],
        sizeClassNames[size],
        loading && styles.loading,
        className,
      )}
      aria-busy={loading || undefined}
      aria-disabled={loading || props['aria-disabled'] || undefined}
      onClick={handleClick}
    >
      {loading ? (
        <>
          <span className={styles.loadingLabel}>{children}</span>
          <span className={styles.spinnerSlot}>
            <Spinner size={size === 'sm' ? 'sm' : 'md'} />
          </span>
        </>
      ) : (
        children
      )}
    </button>
  );
});
