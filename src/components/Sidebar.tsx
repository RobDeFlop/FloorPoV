import { useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';

const gameModes = ['Mythic+', 'Raid', 'PvP'];

const links = [
  { label: 'GitHub', url: 'https://github.com' },
  { label: 'Discord', url: 'https://discord.com' },
];

interface SidebarProps {
  onNavigate: (view: 'main' | 'settings') => void;
  currentView: 'main' | 'settings';
}

export function Sidebar({ onNavigate, currentView }: SidebarProps) {
  const [activeMode, setActiveMode] = useState<string | null>(null);
  const reduceMotion = useReducedMotion();

  return (
    <aside className="w-48 bg-neutral-900 border-r border-neutral-800/80 flex flex-col">
      <nav className="flex-1 p-2 pt-3">
        {gameModes.map((mode) => (
          <motion.button
            key={mode}
            onClick={() => setActiveMode(activeMode === mode ? null : mode)}
            className={`w-full text-left px-3 py-2 rounded text-sm transition-colors mb-1 ${
              activeMode === mode
                ? 'bg-emerald-500/20 text-emerald-100 border border-emerald-400/25'
                : 'text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800'
            }`}
            whileHover={reduceMotion ? undefined : { x: 2 }}
            whileTap={reduceMotion ? undefined : { scale: 0.99 }}
          >
            {mode}
          </motion.button>
        ))}
      </nav>
      <div className="p-2 border-t border-neutral-800/80">
        <motion.button 
          onClick={() => onNavigate('settings')}
          className={`w-full text-left px-3 py-2 rounded text-sm transition-colors mb-2 ${
            currentView === 'settings'
              ? 'bg-emerald-500/20 text-emerald-100 border border-emerald-400/25'
              : 'text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800'
          }`}
          whileHover={reduceMotion ? undefined : { x: 2 }}
          whileTap={reduceMotion ? undefined : { scale: 0.99 }}
        >
          Settings
        </motion.button>
        <div className="flex gap-2 px-3">
          {links.map((link) => (
            <a
              key={link.label}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-neutral-500 hover:text-neutral-300 transition-colors text-sm"
            >
              {link.label}
            </a>
          ))}
        </div>
      </div>
    </aside>
  );
}
