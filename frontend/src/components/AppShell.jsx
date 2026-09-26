import { Building2, LogOut, Radar, SquareKanban, Ticket, Users } from 'lucide-react';
import Dashboard from '../Dashboard.jsx';
import ClientsPage from '../pages/ClientsPage.jsx';
import KanbanPage from '../pages/KanbanPage.jsx';
import TeamPage from '../pages/TeamPage.jsx';
import TicketsPage from '../pages/TicketsPage.jsx';
import { useAuth } from '../lib/auth.jsx';
import { ROLE_META } from '../lib/labels.js';
import { useHashRoute } from '../lib/useHashRoute.js';
import { Avatar, Badge, IconButton, Spinner, cx } from './ui.jsx';

const ROUTES = [
  { path: 'prospeccao', label: 'Prospecção', icon: Radar, element: Dashboard },
  { path: 'kanban', label: 'Kanban', icon: SquareKanban, element: KanbanPage },
  { path: 'clientes', label: 'Clientes', icon: Building2, element: ClientsPage },
  { path: 'chamados', label: 'Chamados', icon: Ticket, element: TicketsPage },
  { path: 'equipa', label: 'Equipa', icon: Users, element: TeamPage, managersOnly: true },
];

export default function AppShell() {
  const { user, isLoading, isManager, logout } = useAuth();
  const [route, navigate] = useHashRoute('prospeccao');

  // Espera o papel do utilizador: sem isso o menu e o redirecionamento de rotas restritas
  // seriam calculados como "sem permissão" (F5 em #/equipa mandaria um admin para outra página).
  if (isLoading || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#111111]">
        <Spinner label="A preparar o seu espaço..." />
      </div>
    );
  }

  const routes = ROUTES.filter((r) => !r.managersOnly || isManager);
  const current = routes.find((r) => r.path === route) ?? routes[0];
  const Page = current.element;

  const renderNav = (className) => (
    <nav aria-label="Módulos" className={className}>
      {routes.map((r) => {
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
              'inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium whitespace-nowrap transition',
              active ? 'bg-red-950/50 text-white ring-1 ring-red-900/60' : 'text-neutral-400 hover:bg-neutral-800/70 hover:text-white',
            )}
          >
            <r.icon className={cx('size-4', active && 'text-red-500')} />
            {r.label}
          </a>
        );
      })}
    </nav>
  );

  return (
    <div className="min-h-screen bg-[#111111] bg-[radial-gradient(ellipse_80%_40%_at_50%_-10%,rgba(127,29,29,0.18),transparent)]">
      <header className="sticky top-0 z-40 border-b border-red-950/80 bg-[#1a1a1a]/90 backdrop-blur-md">
        <div className="h-0.5 bg-linear-to-r from-red-950 via-red-700 to-red-950" />
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-3 sm:px-6 lg:px-8">
          <a href="#/prospeccao" onClick={(e) => { e.preventDefault(); navigate('prospeccao'); }} className="flex shrink-0 items-center gap-2.5">
            <span className="flex size-9 items-center justify-center rounded-xl bg-linear-to-br from-red-700 to-red-950 text-white shadow-lg shadow-red-950/60 ring-1 ring-red-600/30">
              <Radar className="size-5" />
            </span>
            <span className="text-lg font-bold tracking-tight text-white">
              Nexus<span className="text-red-600">.</span>
            </span>
          </a>

          {renderNav('hidden flex-1 items-center gap-1 lg:flex')}

          <div className="ml-auto flex items-center gap-3">
            {user && (
              <div className="flex items-center gap-2.5">
                <Avatar name={user.name} id={user.id} size="sm" />
                <div className="hidden leading-tight sm:block">
                  <p className="max-w-36 truncate text-sm font-semibold text-white">{user.name}</p>
                  <Badge tone={ROLE_META[user.role].tone} className="mt-0.5 !px-1.5 !py-0 text-[10px]">
                    {ROLE_META[user.role].label}
                  </Badge>
                </div>
              </div>
            )}
            <IconButton icon={LogOut} label="Sair" onClick={logout} className="size-9" />
          </div>
        </div>

        {/* Navegação em telemóvel/tablet: faixa rolável */}
        {renderNav('flex gap-1 overflow-x-auto border-t border-neutral-800/70 px-4 py-2 sm:px-6 lg:hidden')}
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <Page key={current.path} />
      </main>
    </div>
  );
}
