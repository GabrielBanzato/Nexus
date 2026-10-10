import { useEffect, useState } from 'react';
import { BarChart3, Building2, FileSignature, Filter, Handshake, LogOut, MessagesSquare, Radar, SquareKanban, Ticket, Trophy, Users } from 'lucide-react';
import Dashboard from '../Dashboard.jsx';
import AttendancePage from '../pages/AttendancePage.jsx';
import ClientsPage from '../pages/ClientsPage.jsx';
import ContractsPage from '../pages/ContractsPage.jsx';
import FloorPage from '../pages/FloorPage.jsx';
import KanbanPage from '../pages/KanbanPage.jsx';
import PerformancePage from '../pages/PerformancePage.jsx';
import PipelinePage from '../pages/PipelinePage.jsx';
import TeamPage from '../pages/TeamPage.jsx';
import TicketsPage from '../pages/TicketsPage.jsx';
import TriagePage from '../pages/TriagePage.jsx';
import { useAuth } from '../lib/auth.jsx';
import { ROLE_META } from '../lib/labels.js';
import { useHashRoute } from '../lib/useHashRoute.js';
import { useLiveUpdates } from '../lib/useLiveUpdates.js';
import { useSocketEvent } from '../lib/socket.js';
import { useToast } from './toast.jsx';
import AdminAlarm from './AdminAlarm.jsx';
import { AppSetupIconButton, AppSetupModal, AppSetupSidebarButton, InstallBanner, useAppSetup } from './AppSetup.jsx';
import { Avatar, Badge, IconButton, Spinner, cx } from './ui.jsx';

/**
 * `adminOnly` (grupo ou rota): nem aparece no menu nem é roteável para outros papéis.
 * O backend também bloqueia essas rotas (403); isto só evita expor a página na interface.
 */
const GROUPS = [
  {
    label: 'Comercial',
    routes: [
      // Radar/scraper e base bruta de leads: exclusivo do admin.
      { path: 'prospeccao', label: 'Prospecção', icon: Radar, element: Dashboard, adminOnly: true },
      { path: 'triagem', label: 'Triagem', icon: Filter, element: TriagePage },
      { path: 'pipeline', label: 'Pipeline', icon: Handshake, element: PipelinePage, wide: true },
      // Aberto a todos: o ranking da equipe é visível para fomentar a competição saudável.
      { path: 'desempenho', label: 'Desempenho', icon: BarChart3, element: PerformancePage },
      // Metas vistas de cima: cada um vê as metas em que participa.
      { path: 'piso', label: 'Piso', icon: Trophy, element: FloorPage },
    ],
  },
  {
    label: 'Atendimento',
    routes: [
      // Todos os papéis: o servidor só devolve os clientes de que cada um é responsável.
      { path: 'atendimento', label: 'Central de Atendimento', icon: MessagesSquare, element: AttendancePage, wide: true },
    ],
  },
  {
    label: 'Operações',
    routes: [
      { path: 'kanban', label: 'Kanban', icon: SquareKanban, element: KanbanPage, wide: true },
      { path: 'clientes', label: 'Clientes', icon: Building2, element: ClientsPage },
      { path: 'chamados', label: 'Chamados', icon: Ticket, element: TicketsPage },
    ],
  },
  {
    label: 'Administração',
    adminOnly: true, // criar contas e senhas é exclusivo dos administradores
    routes: [
      { path: 'equipe', label: 'equipe', icon: Users, element: TeamPage },
      // Contratos (comissões), mensalidades e metas: só o admin.
      { path: 'contratos', label: 'Contratos e metas', icon: FileSignature, element: ContractsPage },
    ],
  },
];

const LIVE = {
  live: { label: 'Ao vivo', dot: 'bg-emerald-400', ping: true },
  connecting: { label: 'Conectando...', dot: 'bg-amber-400' },
  polling: { label: 'Sincroniza a cada 15s', dot: 'bg-sky-400', title: 'A rede ou um antivírus está retendo o canal em tempo real; os dados são atualizados periodicamente.' },
  offline: { label: 'Sem conexão', dot: 'bg-red-500' },
};

function LiveIndicator({ status }) {
  const meta = LIVE[status];
  return (
    <span className="flex items-center gap-2 text-xs text-neutral-500" title={meta.title ?? 'Atualizações em tempo real da equipe'} role="status">
      <span className="relative flex size-2">
        {meta.ping && <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60" />}
        <span className={cx('relative inline-flex size-2 rounded-full', meta.dot)} />
      </span>
      {meta.label}
    </span>
  );
}

/** Menu visível para o utilizador: remove grupos e rotas `adminOnly` e grupos que ficarem vazios. */
function visibleGroups(isAdmin) {
  return GROUPS.filter((g) => !g.adminOnly || isAdmin)
    .map((g) => ({ ...g, routes: g.routes.filter((r) => !r.adminOnly || isAdmin) }))
    .filter((g) => g.routes.length > 0);
}

const reminderTime = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });

/**
 * Lembrete de reunião (servidor: jobs/meetingReminders.js), em qualquer página do Nexus: no dia
 * (de manhã) e 1h antes, para quem conduz. Fica 1 minuto no ecrã, com atalho para a sala.
 */
function useMeetingReminders() {
  const toast = useToast();
  useSocketEvent('meeting:reminder', ({ kind, meeting, client_notified: clientNotified }) => {
    const time = reminderTime.format(new Date(meeting.scheduled_at));
    const title = kind === 'day' ? `Hoje às ${time}: reunião com ${meeting.client_name}` : `Em 1 hora (${time}): reunião com ${meeting.client_name}`;
    const message = clientNotified ? 'O cliente também recebeu o lembrete no WhatsApp.' : 'Não foi possível lembrar o cliente pelo WhatsApp.';
    toast.info(title, message, {
      duration: 60_000,
      action: meeting.link ? { label: 'Abrir a sala', onClick: () => window.open(meeting.link, '_blank', 'noopener') } : undefined,
    });
  });
}

/**
 * Admin: o reinício diário do WhatsApp (servidor, 7h) não conseguiu religar e apagou a sessão,
 * ou o número foi desligado no telemóvel. Avisa em qualquer página, com atalho para o QR Code.
 */
function useWhatsAppAlerts(enabled) {
  const toast = useToast();
  useSocketEvent('whatsapp:needs_qr', ({ reason }) => {
    if (!enabled) return;
    toast.error(
      'WhatsApp desconectado: leia o QR Code de novo',
      `${{
        daily_restart_failed: 'A conexão não voltou no reinício automático da manhã.',
        stuck_syncing: 'O WhatsApp ficou travado sincronizando, mesmo depois de reiniciar.',
      }[reason] ?? 'O número foi desconectado do WhatsApp Web.'} Até ler o QR, a Central não envia nem recebe mensagens.`,
      { duration: 120_000, action: { label: 'Abrir o QR Code', onClick: () => { window.location.hash = '/equipe'; } } },
    );
  });
}

export default function AppShell() {
  const { user, isLoading, isAdmin, logout } = useAuth();
  const [route, navigate] = useHashRoute('');
  const live = useLiveUpdates(user?.id);
  useMeetingReminders();
  useWhatsAppAlerts(isAdmin);
  const appSetup = useAppSetup();
  const [setupOpen, setSetupOpen] = useState(false);

  const groups = visibleGroups(isAdmin);
  const routes = groups.flatMap((g) => g.routes);
  // Rota inexistente ou restrita (ex.: parceiro abrindo #/prospeccao) cai na página inicial do papel.
  const home = routes[0];
  const current = routes.find((r) => r.path === route) ?? home;

  // Corrige o endereço para a página realmente exibida (sem criar entrada no histórico).
  useEffect(() => {
    // Só com o papel carregado: antes disso um admin seria tratado como "sem permissão".
    if (!isLoading && user && route !== current.path) window.history.replaceState(null, '', `#/${current.path}`);
  }, [isLoading, user, route, current.path]);

  // Espera o papel do utilizador: sem isso o menu e o redirecionamento de rotas restritas
  // seriam calculados como "sem permissão" (F5 em #/equipe mandaria um admin para outra página).
  if (isLoading || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#111111]">
        <Spinner label="Preparando seu espaço..." />
      </div>
    );
  }

  const Page = current.element;

  const link = (r, compact = false) => {
    const active = r.path === current.path;
    return (
      <a
        key={r.path}
        href={`#/${r.path}`}
        aria-current={active ? 'page' : undefined}
        onClick={(event) => {
          event.preventDefault();
          navigate(r.path);
        }}
        className={cx(
          'flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium whitespace-nowrap transition',
          active ? 'bg-red-950/50 text-white ring-1 ring-red-900/60' : 'text-neutral-400 hover:bg-neutral-800/70 hover:text-white',
          compact && 'gap-2',
        )}
      >
        <r.icon className={cx('size-4', active && 'text-red-500')} />
        {r.label}
      </a>
    );
  };

  const brand = (
    <a href={`#/${home.path}`} onClick={(e) => { e.preventDefault(); navigate(home.path); }} className="flex shrink-0 items-center gap-2.5">
      <span className="flex size-9 items-center justify-center rounded-xl bg-linear-to-br from-red-700 to-red-950 text-white shadow-lg shadow-red-950/60 ring-1 ring-red-600/30">
        <Radar className="size-5" />
      </span>
      <span className="text-lg font-bold tracking-tight text-white">
        Nexus<span className="text-red-600">.</span>
      </span>
    </a>
  );

  const userCard = (
    <div className="flex items-center gap-2.5">
      <Avatar name={user.name} id={user.id} size="sm" />
      <div className="min-w-0 flex-1 leading-tight">
        <p className="truncate text-sm font-semibold text-white">{user.name}</p>
        <Badge tone={ROLE_META[user.role].tone} className="mt-0.5 !px-1.5 !py-0 text-[10px]">{ROLE_META[user.role].label}</Badge>
      </div>
      <IconButton icon={LogOut} label="Sair" onClick={logout} className="size-9" />
    </div>
  );

  return (
    <div className="min-h-screen bg-[#111111] bg-[radial-gradient(ellipse_80%_40%_at_50%_-10%,rgba(127,29,29,0.18),transparent)]">
      {/* Barra lateral (desktop) */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col border-r border-neutral-800/80 bg-[#161616]/95 lg:flex">
        <div className="h-0.5 bg-linear-to-r from-red-950 via-red-700 to-red-950" />
        <div className="px-5 py-4">{brand}</div>
        <nav aria-label="Módulos" className="flex-1 space-y-5 overflow-y-auto px-3 py-2">
          {groups.map((group) => (
            <div key={group.label}>
              <p className="mb-1.5 px-3 text-[11px] font-semibold tracking-wider text-neutral-600 uppercase">{group.label}</p>
              <div className="space-y-0.5">{group.routes.map((r) => link(r))}</div>
            </div>
          ))}
        </nav>
        <div className="space-y-3 border-t border-neutral-800 p-4">
          <AppSetupSidebarButton setup={appSetup} onClick={() => setSetupOpen(true)} />
          <LiveIndicator status={live} />
          {userCard}
        </div>
      </aside>

      {/* Topo (telemóvel/tablet) */}
      <header className="sticky top-0 z-40 border-b border-red-950/80 bg-[#1a1a1a]/90 backdrop-blur-md lg:hidden">
        <div className="h-0.5 bg-linear-to-r from-red-950 via-red-700 to-red-950" />
        <div className="flex items-center gap-3 px-4 py-3 sm:px-6">
          {brand}
          <div className="ml-auto flex items-center gap-3">
            <LiveIndicator status={live} />
            <AppSetupIconButton setup={appSetup} onClick={() => setSetupOpen(true)} />
            <Avatar name={user.name} id={user.id} size="sm" />
            <IconButton icon={LogOut} label="Sair" onClick={logout} className="size-9" />
          </div>
        </div>
        <nav aria-label="Módulos" className="flex gap-1 overflow-x-auto border-t border-neutral-800/70 px-4 py-2 sm:px-6">
          {routes.map((r) => link(r, true))}
        </nav>
      </header>

      {/* Quadros usam a largura toda; páginas de leitura ficam limitadas para não esticar linhas. */}
      <main className="px-4 py-6 sm:px-6 lg:ml-60 lg:px-8">
        <div className={cx(!current.wide && 'mx-auto max-w-[1400px]')}>
          <InstallBanner setup={appSetup} onOpen={() => setSetupOpen(true)} />
          <Page key={current.path} navigate={navigate} />
        </div>
      </main>
      <AppSetupModal open={setupOpen} onClose={() => setSetupOpen(false)} setup={appSetup} />
      {/* Admin: cliente fechado (alarme até confirmar) e negócio perdido, em qualquer página. */}
      {isAdmin && <AdminAlarm enabled />}
    </div>
  );
}
