import React from 'react';
import { Home, Server, Globe2 } from 'lucide-react';
import { ViewState } from '../types';

interface NavigationProps {
  currentView: ViewState;
  setView: (view: ViewState) => void;
}

export function Navigation({
  currentView,
  setView,
}: NavigationProps) {
  const navItems = [
    { id: 'dashboard' as ViewState, icon: Home, label: 'خانه' },
    { id: 'profiles' as ViewState, icon: Server, label: 'کانفیگ‌ها' },
    { id: 'dns' as ViewState, icon: Globe2, label: 'ابزار DNS' },
  ];

  return (
    <div className="absolute bottom-0 w-full glass-panel border-b-0 border-x-0 border-t 
                    rounded-t-2xl pb-safe z-50 overflow-hidden">
      <div className="flex justify-around items-center h-20 px-4">
        {navItems.map((item) => {
          const isActive = currentView === item.id;
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              onClick={() => setView(item.id)}
              className={`flex flex-col items-center justify-center w-20 h-full relative transition-colors delay-75
                        ${isActive ? 'text-cyan-400' : 'text-zinc-500 hover:text-zinc-300'}`}
            >
              {isActive && (
                <div className="absolute top-0 w-10 h-1 bg-cyan-400 rounded-b-full shadow-[0_0_10px_cyan]"></div>
              )}
              <Icon size={24} className={`mb-1 transition-transform ${isActive ? 'scale-110' : ''}`} />
              <span className="text-[10px] font-medium tracking-wide">{item.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
