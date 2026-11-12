import { Panel } from '@/components/admin/Panel'
import { DescriptionList } from '@/components/admin/DescriptionList'
import { formatDate, formatMoney } from '@/lib/admin/format'

/** `GET /org-finance/organisations/:id` — amounts are minor units as strings (BigInt columns). */
export interface WalletPlan {
  id: string
  startDate: string
  endDate: string | null
  remainingProjects: number | null
  remainingPrivateTesters: number | null
  plan: {
    id: string
    name: string
    description: string | null
    priceMinor: string | null
    currency: string
    archivedAt: string | null
  }
}

export interface WalletBuild {
  id: string
  name: string
  status: string
  testerRewardMinor: string | null
  rewardsCurrency: string | null
  project: { id: string; reference: string; title: string }
  lockedTotalMinor: string
  drawnMinor: string
  releasedMinor: string
  remainingMinor: string
}

export interface WalletRow {
  id: string
  reference: string
  walletMove: 'TOP_UP' | 'LOCK' | 'DRAW' | 'RELEASE'
  amountMinor: string
  currency: string
  description: string | null
  externalRef: string | null
  occurredAt: string
  project: { id: string; reference: string; title: string } | null
  build: { id: string; name: string } | null
  counterparty: { id: string; firstName: string | null; lastName: string | null } | null
}

export interface Wallet {
  organisation: { id: string; name: string }
  currency: string
  balanceMinor: string
  lockedMinor: string
  builds: WalletBuild[]
  currentPlan: WalletPlan | null
  plans: WalletPlan[]
  history: WalletRow[]
}

export const WALLET_MOVE_LABELS: Record<WalletRow['walletMove'], string> = {
  TOP_UP: 'Top-up',
  LOCK: 'Locked for a build',
  DRAW: 'Paid to a tester',
  RELEASE: 'Released back',
}

export function planLabel(p: WalletPlan | null): string {
  if (!p) return 'No active plan'
  return `${p.plan.name} · ${formatDate(p.startDate)} – ${p.endDate ? formatDate(p.endDate) : 'open-ended'}`
}

const figure = {
  fontVariantNumeric: 'tabular-nums',
  fontWeight: 'var(--fw-semibold)',
  color: 'var(--text-primary)',
} as const

/**
 * The read-only wallet figures: balance, locked, the plan, and what is locked
 * per build. Shared by the admin wallet page and the customer's own view.
 */
export function WalletSummary({ wallet, title }: { wallet: Wallet; title?: string }) {
  const funded = wallet.builds.filter((b) => b.lockedTotalMinor !== '0')
  return (
    <Panel
      title={title ?? 'Wallet'}
      description="Balance is paid in and not yet set aside. Locked is held for builds and pays their testers."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
        <DescriptionList
          items={[
            {
              label: 'Balance',
              value: (
                <span style={figure}>{formatMoney(wallet.balanceMinor, wallet.currency)}</span>
              ),
            },
            {
              label: 'Locked',
              value: <span style={figure}>{formatMoney(wallet.lockedMinor, wallet.currency)}</span>,
            },
            { label: 'Plan', value: planLabel(wallet.currentPlan) },
          ]}
        />
        {funded.length > 0 ? (
          <DescriptionList
            items={funded.map((b) => ({
              label: `${b.project.title} · ${b.name}`,
              value: (
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {formatMoney(b.remainingMinor, wallet.currency)} locked
                  <span style={{ color: 'var(--text-muted)' }}>
                    {' '}
                    of {formatMoney(b.lockedTotalMinor, wallet.currency)}
                  </span>
                </span>
              ),
            }))}
          />
        ) : null}
      </div>
    </Panel>
  )
}
