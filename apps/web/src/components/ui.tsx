import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from 'react';

const BUTTON_VARIANTS = {
  primary: 'bg-blue-600 text-white hover:bg-blue-700 disabled:bg-blue-300',
  secondary:
    'bg-white text-slate-700 border border-slate-300 hover:bg-slate-50 disabled:text-slate-400',
  danger: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300',
  ghost: 'text-slate-600 hover:bg-slate-100 disabled:text-slate-300',
} as const;

export function Button({
  variant = 'primary',
  small,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof BUTTON_VARIANTS;
  small?: boolean;
}) {
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed ${
        small ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-2 text-sm'
      } ${BUTTON_VARIANTS[variant]} ${className}`}
    />
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-slate-100 ${props.className ?? ''}`}
    />
  );
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={`w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 ${props.className ?? ''}`}
    />
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-slate-500">{hint}</span> : null}
    </label>
  );
}

export function Card({
  title,
  actions,
  children,
  className = '',
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-lg border border-slate-200 bg-white shadow-sm ${className}`}>
      {title !== undefined || actions !== undefined ? (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
          {actions}
        </header>
      ) : null}
      <div className="p-4">{children}</div>
    </section>
  );
}

const BADGE_TONES = {
  green: 'bg-green-100 text-green-800',
  red: 'bg-red-100 text-red-800',
  yellow: 'bg-yellow-100 text-yellow-800',
  blue: 'bg-blue-100 text-blue-800',
  gray: 'bg-slate-100 text-slate-600',
} as const;

export function Badge({
  tone = 'gray',
  children,
}: {
  tone?: keyof typeof BADGE_TONES;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${BADGE_TONES[tone]}`}
    >
      {children}
    </span>
  );
}

export function OnlineDot({ online }: { online: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-2.5 w-2.5 rounded-full ${online ? 'bg-green-500' : 'bg-slate-300'}`} />
      <span className={`text-xs font-medium ${online ? 'text-green-700' : 'text-slate-500'}`}>
        {online ? 'Online' : 'Offline'}
      </span>
    </span>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 p-8 text-sm text-slate-500">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-blue-600" />
      {label ?? 'Loading…'}
    </div>
  );
}

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
      {message}
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center sm:p-10">
      <p className="text-sm font-medium text-slate-600">{title}</p>
      {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
        {subtitle ? <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      // pt-16 on a phone wastes a quarter of the screen and pushes the actions
      // of a long form below the fold; the roomier offset starts at sm.
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-3 pt-6 sm:p-4 sm:pt-16"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`w-full ${wide ? 'max-w-3xl' : 'max-w-md'} rounded-lg bg-white shadow-xl`}>
        <header className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <h2 className="text-base font-semibold text-slate-900">{title}</h2>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600"
            aria-label="Close"
          >
            ✕
          </button>
        </header>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

/*
 * `whitespace-nowrap` is what makes a table usable on a phone, and it is not
 * obvious why.
 *
 * These tables are `min-w-full` with auto layout, so in a 343px viewport the
 * table does NOT overflow — it shrinks to fit by wrapping cell text, giving
 * seven ~49px columns of one word per line and no scrollbar to escape with.
 * Wrapping a container in `overflow-x-auto` changes nothing on its own,
 * because nothing ever overflows.
 *
 * Holding each cell on one line gives the table a real intrinsic minimum
 * width. It then genuinely overflows, and TableCard's scroll container
 * engages. Pass `className` to opt a column out where wrapping is wanted;
 * `truncate` already implies nowrap, so cells that use it are unaffected.
 */
export function Th({
  children,
  className = '',
  wrap,
}: {
  children?: ReactNode;
  className?: string;
  wrap?: boolean;
}) {
  return (
    <th
      className={`${wrap ? '' : 'whitespace-nowrap'} px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 ${className}`}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  className = '',
  wrap,
}: {
  children?: ReactNode;
  className?: string;
  /**
   * Lets this cell's text wrap — for long free text such as a log line, where
   * one unbroken row would make the horizontal scroll useless.
   *
   * A prop rather than a `whitespace-normal` in `className`, because both
   * classes set the same property at the same specificity: which one won would
   * depend on Tailwind's output order, not on the order they are written here.
   */
  wrap?: boolean;
}) {
  return (
    <td
      className={`${wrap ? '' : 'whitespace-nowrap'} px-3 py-2.5 text-sm text-slate-700 ${className}`}
    >
      {children}
    </td>
  );
}

/**
 * Card-framed table that scrolls sideways instead of clipping.
 *
 * Every table in the app previously sat directly in a box with
 * `overflow-hidden`, which on a narrow screen hides the right-hand columns with
 * no way to reach them. The scroll lives on an inner element so the card keeps
 * its rounded corners — putting `overflow-x` on the bordered box itself clips
 * them square.
 */
export function TableCard({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm ${className}`}
    >
      <div className="overflow-x-auto">{children}</div>
    </div>
  );
}
