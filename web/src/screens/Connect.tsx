// /connect: the Hive Connect product flow (spec 2026-11-03, section 1).
// 1 Invite: admins create a member invite link; members see their own. 2 Run one command: `npx hive-connect
// connect --hub <hub>` inside the repository. 3 Waiting: ticks as the pairing is approved, the checkout is
// reported and the first agent registers. The hand-configured token path stays behind a disclosure for admins.
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion, type HTMLMotionProps } from 'motion/react';
import { Lock } from 'lucide-react';
import { Accordion } from '@/components/arc/accordion/accordion';
import { EmptyState } from '@/components/arc/empty-state/empty-state';
import { motionTokens } from '@/components/arc/lib/motion-tokens';
import { Stepper } from '@/components/arc/stepper/stepper';
import { Page, useHive } from '@/shell';
import { AdvancedToken } from './connect/AdvancedToken';
import { CommandStep } from './connect/CommandStep';
import { InviteStep } from './connect/InviteStep';
import { WaitingStep, type WaitBaseline } from './connect/WaitingStep';
import { connectCommand, serviceBase, type ConnectClientId } from './connect/logic';
import { connectorsOf, type CreatedInvite } from './connect/shared';
import styles from './connect/Connect.module.css';

type Step = 0 | 1 | 2;
const STEP_PARAM: Record<string, Step> = { invite: 0, command: 1, waiting: 2 };
const STEP_NAME = ['invite', 'command', 'waiting'] as const;
const EMPTY_BASELINE: WaitBaseline = { connectorIds: [], sessionIds: [] };

export default function Connect() {
  const { me, identity, workspace, status, memberSummaries, snapshot } = useHive();
  const reduced = useReducedMotion() ?? false;
  const [params, setParams] = useSearchParams();
  const step: Step = STEP_PARAM[params.get('step') ?? ''] ?? 0;
  const setStep = (next: Step) => setParams(next === 0 ? {} : { step: STEP_NAME[next] }, { replace: true });
  const [invite, setInvite] = useState<CreatedInvite | null>(null);
  const [client, setClient] = useState<ConnectClientId>('claude-code');

  // What already existed when this page opened; step 3 counts only what appears after it.
  const [baseline, setBaseline] = useState<WaitBaseline | null>(null);
  useEffect(() => {
    if (baseline === null && status === 'ready') {
      setBaseline({ connectorIds: connectorsOf(memberSummaries).map(c => c.tokenId), sessionIds: snapshot.sessions.map(s => s.id) });
    }
  }, [baseline, status, memberSummaries, snapshot.sessions]);

  const isAdmin = me?.role === 'admin';
  const hubUrl = serviceBase(identity?.hubUrl ?? workspace.cloudLink);
  const command = identity?.connect?.cliCommand ?? connectCommand(hubUrl);
  // Follow the teammate invited on this visit; members follow themselves; an admin without an invite follows anyone.
  const follow = invite?.memberName ?? (isAdmin ? null : me?.name ?? null);
  const person = invite?.memberName ?? null;

  if (me?.role === 'viewer') {
    return (
      <Page title="Connect a repository" width="narrow">
        <div className={styles.panel}>
          <EmptyState
            icon={<Lock size={20} />}
            title="Viewers cannot connect repositories"
            description="Your token lets you read this workspace. Ask an admin for a member invite link if you want your agent to join."
          />
        </div>
      </Page>
    );
  }

  const steps = [
    { id: 'invite', label: 'Invite', description: isAdmin ? 'Create an invite link' : 'Your invite link' },
    { id: 'command', label: 'Run one command', description: 'Inside the repository' },
    { id: 'waiting', label: 'Waiting', description: 'Approve, report, register' },
  ];

  const enterEase = [...motionTokens.ease.enter] as [number, number, number, number];
  const exitEase = [...motionTokens.ease.exit] as [number, number, number, number];
  const motionProps: HTMLMotionProps<'div'> = reduced
    ? { initial: false, animate: { opacity: 1 }, exit: { opacity: 0, transition: { duration: 0 } } }
    : {
        initial: { opacity: 0, y: 8 },
        animate: { opacity: 1, y: 0, transition: { duration: motionTokens.duration.standard, ease: enterEase } },
        exit: { opacity: 0, y: -4, transition: { duration: motionTokens.duration.exit, ease: exitEase } },
      };

  return (
    <Page
      title={isAdmin ? 'Invite a teammate' : 'Connect your repository'}
      description={isAdmin
        ? 'Send an invite link. They run one command in the repository they already have, approve it in the browser, and their agent appears here.'
        : 'Run one command in the repository you already work in, approve it in the browser, and your agent appears here.'}
      width="narrow"
    >
      <div className={styles.flow}>
        <Stepper steps={steps} current={step} onStepSelect={(index) => setStep(index as Step)} details="current" label="Connect progress" />
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={step} {...motionProps}>
            {step === 0 && (
              <InviteStep hubUrl={hubUrl} invite={invite} onCreated={setInvite} onReset={() => setInvite(null)} onContinue={() => setStep(1)} />
            )}
            {step === 1 && (
              <CommandStep command={command} hubUrl={hubUrl} person={person} client={client} onClientChange={setClient}
                onBack={() => setStep(0)} onContinue={() => setStep(2)} />
            )}
            {step === 2 && (
              <WaitingStep baseline={baseline ?? EMPTY_BASELINE} member={follow}
                onBack={() => setStep(1)} onStartOver={() => { setInvite(null); setStep(0); }} />
            )}
          </motion.div>
        </AnimatePresence>
        {isAdmin && (
          <div className={styles.advancedWrap}>
            <Accordion defaultOpen={-1} items={[{ title: 'Advanced: a token for a client configured by hand', content: <AdvancedToken hubUrl={hubUrl} /> }]} />
          </div>
        )}
      </div>
    </Page>
  );
}
