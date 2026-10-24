import { Icon } from './Icon';
import { formatBytes } from '../lib/format-utils';
import type { MetaField, Sensitivity } from '../lib/types';

const SENSITIVITY_LABEL: Record<Sensitivity, string> = {
  high: '敏感',
  medium: '注意',
  low: '一般',
  none: '技术',
};

const CATEGORY_ICON: Record<string, 'pin' | 'camera' | 'clock' | 'user' | 'wrench' | 'info' | 'image'> = {
  位置: 'pin',
  设备: 'camera',
  时间: 'clock',
  作者: 'user',
  // The real category strings contain slashes, matched separately below.
};

function iconFor(category: string) {
  if (category.startsWith('位置')) return 'pin' as const;
  if (category.startsWith('设备')) return 'camera' as const;
  if (category.startsWith('时间')) return 'clock' as const;
  if (category.startsWith('作者')) return 'user' as const;
  if (category.startsWith('软件')) return 'wrench' as const;
  if (category.startsWith('图像') || category.startsWith('色彩')) return 'image' as const;
  return 'info' as const;
}

export interface MetadataTableProps {
  fields: MetaField[];
  /** Show the container badge (Exif / XMP / IPTC …). */
  showContainer?: boolean;
  emptyText?: string;
}

export function MetadataTable({ fields, showContainer = true, emptyText = '没有检测到可解析的字段。' }: MetadataTableProps) {
  if (fields.length === 0) {
    return (
      <div className="empty-inline">
        <Icon name="shield" size={16} />
        <span>{emptyText}</span>
      </div>
    );
  }

  const groups = new Map<string, MetaField[]>();
  for (const field of fields) {
    const list = groups.get(field.category) ?? [];
    list.push(field);
    groups.set(field.category, list);
  }

  return (
    <div className="meta-groups" data-testid="metadata-table">
      {[...groups.entries()].map(([category, list]) => (
        <section className="meta-group" key={category}>
          <h4 className="meta-group-title">
            <Icon name={iconFor(category)} size={14} />
            {category}
            <span className="meta-count">{list.length}</span>
          </h4>
          <div className="meta-rows">
            {list.map((field) => (
              <div className={`meta-row${field.sensitivity === 'high' ? ' sensitive' : ''}`} key={field.key} data-testid="meta-row">
                <span className="meta-label">
                  {field.label}
                  {showContainer ? <span className={`meta-badge ${field.container}`}>{field.container.toUpperCase()}</span> : null}
                </span>
                <span className="meta-value" title={field.value}>
                  {field.value}
                </span>
                <span className={`meta-sens ${field.sensitivity}`} title={`敏感度：${SENSITIVITY_LABEL[field.sensitivity]}`}>
                  {SENSITIVITY_LABEL[field.sensitivity]}
                </span>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export { formatBytes };
void CATEGORY_ICON;
