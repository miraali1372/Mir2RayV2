import React from 'react';
import { Download, Home, RefreshCw, Server, Globe2 } from 'lucide-react';
import { ViewState } from '../types';

interface NavigationProps {
  currentView: ViewState;
  setView: (view: ViewState) => void;
  currentVersion: string;
  latestVersion: string | null;
  updateChecking: boolean;
  updateMessage: string;
  hasUpdate: boolean;
  onCheckUpdate: () => void;
}

export function Navigation({
  currentView,
  setView,
  currentVersion,
  latestVersion,
  updateChecking,
  updateMessage,
  hasUpdate,
  onCheckUpdate,
}: NavigationProps) {
  const navItems = [
    { id: 'dashboard' as ViewState, icon: Home, label: 'خانه' },
    { id: 'profiles' as ViewState, icon: Server, label: 'کانفیگ‌ها' },
    { id: 'dns' as ViewState, icon: Globe2, label: 'ابزار DNS' },
  ];

  return (
    <div className="absolute bottom-0 w-full glass-panel border-b-0 border-x-0 border-t 
                    rounded-t-2xl pb-safe z-50 overflow-hidden">
      <div className="border-b border-zinc-800/70 px-4 py-3">
        <button
          onClick={onCheckUpdate}
          disabled={updateChecking}
          className={`w-full rounded-xl border px-3 py-2.5 flex items-center justify-between gap-3 transition-colors text-right
            ${hasUpdate
              ? 'bg-cyan-500/10 border-cyan-500/30 hover:bg-cyan-500/15 text-cyan-100'
              : 'bg-zinc-900/80 border-zinc-800 hover:bg-zinc-800/80 text-zinc-100'
            } disabled:opacity-60`}
        >
          <div className="flex items-center gap-3 min-w-0">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${hasUpdate ? 'bg-cyan-500/20 text-cyan-300' : 'bg-zinc-800 text-zinc-300'}`}>
              {updateChecking ? <RefreshCw size={16} className="animate-spin" /> : <Download size={16} />}
            </div>
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">آپدیت نرم افزار</div>
              <div className="text-[10px] text-zinc-500 truncate">
                نسخه فعلی {currentVersion}
                {latestVersion ? ` | نسخه جدید ${latestVersion}` : ''}
              </div>
            </div>
          </div>
          <span className="text-xs font-medium shrink-0">
            {updateChecking ? 'در حال بررسی...' : hasUpdate ? 'دانلود و نصب' : 'بررسی'}
          </span>
        </button>
        {updateMessage && (
          <div className={`mt-2 text-[10px] leading-4 ${hasUpdate ? 'text-cyan-200' : 'text-zinc-500'}`}>
            {updateMessage}
          </div>
        )}
      </div>
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
