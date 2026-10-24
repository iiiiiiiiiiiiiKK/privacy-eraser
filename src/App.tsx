import { useCallback, useEffect, useRef, useState } from 'react';

import { Icon, XLogo } from './components/Icon';
import { DetailPanel } from './components/DetailPanel';
import { FileList } from './components/FileList';
import { useTheme } from './hooks/useTheme';
import { useToasts } from './hooks/useToasts';
import { MAX_BATCH_BYTES, MAX_FILE_BYTES, useWorkspace } from './hooks/useWorkspace';
import { cleanedFileName, downloadBytes, downloadZip } from './lib/download';
import { formatBytes, formatDelta, formatPercent } from './lib/format-utils';
import type { CleanResult, WorkItem } from './lib/types';

const SHORTCUTS: Array<{ keys: string; label: string }> = [
  { keys: 'Ctrl / ⌘ + O', label: '选择图片文件' },
  { keys: 'Ctrl / ⌘ + Enter', label: '清理当前图片' },
  { keys: 'Ctrl / ⌘ + S', label: '下载清理后的图片' },
  { keys: 'Ctrl / ⌘ + Shift + Z', label: '清空工作区' },
  { keys: 'Ctrl / ⌘ + Shift + T', label: '切换深色 / 浅色' },
  { keys: 'Delete', label: '移除当前选中的图片' },
  { keys: 'Esc', label: '关闭对话框 / 取消拖放' },
];

export default function App() {
  const { theme, toggleTheme } = useTheme();
  const { toasts, push, dismiss } = useToasts();
  const workspace = useWorkspace();

  const [dragging, setDragging] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const selected = workspace.selected;

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      const result = await workspace.addFiles(files);
      if (result.added > 0) {
        push(`已加入 ${result.added} 张图片，正在本地检查…`, 'success');
      }
      for (const reason of result.skipped) push(reason, 'error');
    },
    [workspace, push],
  );

  // ---------------------------------------------------------------- drag & drop
  useEffect(() => {
    let depth = 0;
    const onEnter = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
      depth += 1;
      setDragging(true);
    };
    const onOver = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    };
    const onLeave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      depth = 0;
      setDragging(false);
      const files = event.dataTransfer?.files;
      if (files && files.length > 0) void handleFiles(files);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [handleFiles]);

  // ---------------------------------------------------------------- downloads
  const downloadOne = useCallback(
    (item: WorkItem | null) => {
      if (!item?.result) {
        push('还没有清理结果可以下载', 'info');
        return;
      }
      const name = cleanedFileName(item.fileName, item.result.ext);
      downloadBytes(item.result.buffer, name, item.result.mime);
      push(`已开始下载 ${name}`, 'success');
    },
    [push],
  );

  const cleanedItems = workspace.items.filter((item) => item.result);

  const downloadAll = useCallback(() => {
    if (cleanedItems.length === 0) {
      push('没有已清理的图片可以打包', 'info');
      return;
    }
    const entries = cleanedItems.map((item) => ({
      name: cleanedFileName(item.fileName, item.result!.ext),
      bytes: item.result!.buffer,
    }));
    downloadZip(entries);
    push(`已打包 ${entries.length} 张清理后的图片`, 'success');
  }, [cleanedItems, push]);

  const runClean = useCallback(
    async (item: WorkItem | null) => {
      if (!item) return;
      const result = await workspace.cleanItem(item.id);
      if (result?.verified) push('清理完成，重新解析未发现残留元数据', 'success');
      else if (result) push('清理完成，但验证未完全通过，请查看说明', 'info');
    },
    [workspace, push],
  );

  // ---------------------------------------------------------------- shortcuts
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) {
        if (event.key === 'Escape') setShortcutsOpen(false);
        if (event.key === 'Delete' && workspace.selectedId) workspace.removeItem(workspace.selectedId);
        return;
      }
      const key = event.key.toLowerCase();
      if (event.shiftKey) {
        if (key === 'z') {
          event.preventDefault();
          workspace.clearAll();
          push('已清空工作区', 'info');
          return;
        }
        if (key === 't') {
          event.preventDefault();
          toggleTheme();
          return;
        }
        return;
      }
      if (key === 'o') {
        event.preventDefault();
        inputRef.current?.click();
        return;
      }
      if (key === 'enter') {
        event.preventDefault();
        void runClean(workspace.selected);
        return;
      }
      if (key === 's') {
        event.preventDefault();
        downloadOne(workspace.selected);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [workspace, runClean, downloadOne, push, toggleTheme]);

  const totals = workspace.totals;
  const highRisk = workspace.items.filter((item) => item.inspection?.risk === 'high').length;

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <Icon name="shield" size={16} />
          </span>
          <span className="brand-text">
            <span className="brand-title">Privacy Eraser</span>
            <span className="brand-sub">隐私橡皮擦 · 图片元数据本地清理</span>
          </span>
        </div>

        <div className="header-actions">
          <span className="local-badge" title="所有解析与清理都在你的浏览器里完成，没有任何上传">
            <Icon name="shield" size={13} />
            100% 本地 · 不上传
          </span>
          <button type="button" className="btn btn-icon" onClick={() => inputRef.current?.click()} title="添加图片 (Ctrl+O)" aria-label="添加图片" data-testid="btn-add">
            <Icon name="upload" size={16} />
          </button>
          <button type="button" className="btn btn-icon" onClick={() => setShortcutsOpen(true)} title="快捷键" aria-label="快捷键" data-testid="btn-shortcuts">
            <Icon name="keyboard" size={16} />
          </button>
          <button
            type="button"
            className="btn btn-icon"
            onClick={toggleTheme}
            title="切换深色 / 浅色 (Ctrl+Shift+T)"
            aria-label="切换深色 / 浅色主题"
            data-testid="btn-theme"
          >
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
          </button>
          <a
            className="x-link"
            href="https://x.com/0xkillcoin"
            target="_blank"
            rel="noopener noreferrer"
            title="作者 @0xkillcoin"
            aria-label="作者 𝕏：@0xkillcoin"
            data-testid="author-link"
          >
            <XLogo size={13} />
            <span className="x-text">@0xkillcoin</span>
          </a>
        </div>
      </header>

      <main className="workspace">
        <aside className="pane pane-list">
          <div className="pane-head">
            <h2>
              工作区
              <span className="pane-count">{workspace.items.length}</span>
            </h2>
            <div className="pane-head-actions">
              <button
                type="button"
                className="mini-btn"
                onClick={() => void workspace.cleanAll()}
                disabled={workspace.busy || workspace.items.length === 0}
                data-testid="btn-clean-all"
              >
                全部清理
              </button>
              <button type="button" className="mini-btn" onClick={() => inputRef.current?.click()}>
                添加
              </button>
            </div>
          </div>

          <div className="pane-summary" data-testid="batch-summary">
            <div>
              <b>{totals.count}</b>
              <span>图片</span>
            </div>
            <div>
              <b className={highRisk > 0 ? 'danger' : ''}>{highRisk}</b>
              <span>含敏感信息</span>
            </div>
            <div>
              <b>{totals.verified}</b>
              <span>已验证清理</span>
            </div>
          </div>

          <div className="pane-scroll">
            {workspace.items.length === 0 ? (
              <div className="empty-side">
                <Icon name="image" size={26} />
                <p>还没有图片</p>
                <span>拖放图片到这里，或点击「添加」</span>
              </div>
            ) : (
              <FileList
                items={workspace.items}
                selectedId={workspace.selectedId}
                onSelect={workspace.setSelectedId}
                onRemove={workspace.removeItem}
              />
            )}
          </div>

          <div className="pane-foot">
            <button
              type="button"
              className="btn btn-block"
              onClick={downloadAll}
              disabled={cleanedItems.length === 0}
              data-testid="btn-batch-download"
            >
              <Icon name="archive" size={15} />
              打包下载已清理（{cleanedItems.length}）
            </button>
            <button
              type="button"
              className="btn btn-block btn-subtle"
              onClick={() => {
                workspace.clearAll();
                push('已清空工作区，图片数据与预览已释放', 'info');
              }}
              disabled={workspace.items.length === 0}
              data-testid="btn-clear-workspace"
            >
              <Icon name="trash" size={15} />
              清空工作区
            </button>
          </div>
        </aside>

        <section className="pane pane-detail">
          {selected ? (
            <DetailPanel
              item={selected}
              options={workspace.options}
              onOptionsChange={workspace.setOptions}
              onClean={() => void runClean(selected)}
              onDownload={() => downloadOne(selected)}
              onDownloadAll={downloadAll}
              onClearAll={() => {
                workspace.clearAll();
                push('已清空工作区', 'info');
              }}
              batchCount={cleanedItems.length}
              busy={workspace.busy}
            />
          ) : (
            <DropHero onPick={() => inputRef.current?.click()} onFiles={(files) => void handleFiles(files)} />
          )}
        </section>
      </main>

      <footer className="statusbar">
        <span className="status-item">
          单文件上限 <b>{formatBytes(MAX_FILE_BYTES)}</b>
        </span>
        <span className="status-item">
          工作区上限 <b>{formatBytes(MAX_BATCH_BYTES)}</b>
        </span>
        {totals.cleaned > 0 ? (
          <span className="status-item" data-testid="status-delta">
            已减少 <b>{formatDelta(totals.bytesBefore, totals.bytesAfter)}</b>（{formatPercent(totals.bytesBefore, totals.bytesAfter)}）
          </span>
        ) : null}
        <span className="status-right">
          <span className="status-item">
            <Icon name="shield" size={12} /> 图片不离开本机 · 关闭页面即释放
          </span>
          <a className="status-item status-link" href="https://x.com/0xkillcoin" target="_blank" rel="noopener noreferrer">
            𝕏 @0xkillcoin
          </a>
        </span>
      </footer>

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif,.jpg,.jpeg,.png,.webp,.gif"
        multiple
        style={{ display: 'none' }}
        data-testid="file-input"
        onChange={(event) => {
          const files = event.target.files;
          if (files && files.length > 0) void handleFiles(files);
          event.target.value = '';
        }}
      />

      {dragging ? (
        <div className="dropzone" data-testid="dropzone">
          <div className="dropzone-inner">
            <Icon name="upload" size={30} />
            <h3>松开以加入图片</h3>
            <p>文件只在本地读取，不会上传</p>
          </div>
        </div>
      ) : null}

      {shortcutsOpen ? (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="键盘快捷键"
          onClick={(event) => {
            if (event.target === event.currentTarget) setShortcutsOpen(false);
          }}
        >
          <div className="modal" data-testid="shortcuts-dialog">
            <div className="modal-head">
              <h2>键盘快捷键</h2>
              <button type="button" className="btn btn-icon" onClick={() => setShortcutsOpen(false)} aria-label="关闭">
                <Icon name="refresh" size={15} />
              </button>
            </div>
            <div className="modal-body">
              {SHORTCUTS.map((shortcut) => (
                <div className="shortcut-row" key={shortcut.keys}>
                  <span>{shortcut.label}</span>
                  <kbd className="kbd">{shortcut.keys}</kbd>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      <div className="toasts" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.kind}`} onClick={() => dismiss(toast.id)}>
            <Icon name={toast.kind === 'error' ? 'alert' : toast.kind === 'info' ? 'info' : 'check'} size={14} />
            <span>{toast.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Large empty state that is also a real file drop / pick target. */
function DropHero({ onPick, onFiles }: { onPick: () => void; onFiles: (files: FileList) => void }) {
  return (
    <div className="hero" data-testid="empty-hero">
      <div className="hero-inner">
        <div className="hero-icon">
          <Icon name="shield" size={30} />
        </div>
        <h1>先看清，再决定要不要发出去</h1>
        <p>
          把图片拖进这里，或者选择文件。我们会在<strong>本地</strong>读取 EXIF / GPS / XMP / IPTC / ICC，
          列出它可能暴露的信息，然后按字节删除元数据、重新解析验证导出结果。
        </p>
        <div className="hero-actions">
          <button type="button" className="btn btn-primary btn-lg" onClick={onPick} data-testid="btn-pick">
            <Icon name="upload" size={16} />
            选择图片
          </button>
          <label className="hero-file">
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              multiple
              style={{ display: 'none' }}
              data-testid="hero-file-input"
              onChange={(event) => {
                const files = event.target.files;
                if (files && files.length > 0) onFiles(files);
                event.target.value = '';
              }}
            />
          </label>
        </div>
        <ul className="hero-facts">
          <li>
            <Icon name="check" size={14} />
            支持 JPEG / PNG / WebP（含动画）
          </li>
          <li>
            <Icon name="check" size={14} />
            清理为字节级删除，不重编码、不损失画质
          </li>
          <li>
            <Icon name="check" size={14} />
            导出前重新解析验证，不靠界面判断
          </li>
          <li>
            <Icon name="check" size={14} />
            不保存图片，关闭页面即释放
          </li>
        </ul>
      </div>
    </div>
  );
}

export type { CleanResult };
