import { Icon } from './Icon';
import { CleanedPreview } from './CleanedPreview';
import { formatBytes, formatCoord, osmLink } from '../lib/format-utils';
import { MetadataTable } from './MetadataTable';
import type { CleanOptions, Inspection, WorkItem } from '../lib/types';

const FORMAT_BOUNDARIES: Array<{ format: string; can: string; cannot: string }> = [
  {
    format: 'JPEG',
    can: 'APP1/Exif（含 GPS、时间、设备、序列号）、APP1/XMP、APP13/IPTC、COM 注释、厂商 APP 段、EOI 之后的额外字节',
    cannot: '像素数据内部被隐写工具直接写入的信息（需要重编码并仍无法保证清除）',
  },
  {
    format: 'PNG',
    can: 'eXIf、tEXt/zTXt/iTXt（含 XMP）、tIME、iCCP（可选保留）、IEND 之后的额外字节',
    cannot: 'IDAT 压缩流中自行编码的数据；非标准私有块无法逐一识别含义',
  },
  {
    format: 'WebP',
    can: 'EXIF 块、XMP 块、ICCP（可选保留）、RIFF 声明之外的额外字节',
    cannot: 'VP8/VP8L 位流中编码的自定义数据',
  },
];

export interface DetailPanelProps {
  item: WorkItem;
  options: CleanOptions;
  onOptionsChange: (options: CleanOptions) => void;
  onClean: () => void;
  onDownload: () => void;
  onDownloadAll: () => void;
  onClearAll: () => void;
  batchCount: number;
  busy: boolean;
}

function riskCopy(risk: Inspection['risk']): { title: string; body: string; tone: string } {
  switch (risk) {
    case 'high':
      return {
        title: '这张图片带有可定位到你的信息',
        body: '检测到位置、设备序列号、作者或精确拍摄时间等高敏感字段。发布前建议清理。',
        tone: 'danger',
      };
    case 'medium':
      return {
        title: '这张图片带有一些可识别信息',
        body: '检测到设备型号、修改时间或描述类字段。它们不一定危险，但会暴露你没有主动分享的细节。',
        tone: 'warn',
      };
    case 'low':
      return {
        title: '只检测到少量技术信息',
        body: '没有发现直接指向你个人或位置的数据，仍可清理以保持一致的输出。',
        tone: 'ok',
      };
    default:
      return {
        title: '没有检测到可解析的元数据',
        body: '这不代表文件里绝对没有任何隐藏信息（见下方能力边界），但常规元数据是空的。',
        tone: 'ok',
      };
  }
}

export function DetailPanel({
  item,
  options,
  onOptionsChange,
  onClean,
  onDownload,
  onDownloadAll,
  onClearAll,
  batchCount,
  busy,
}: DetailPanelProps) {
  const inspection = item.inspection;
  const result = item.result;
  const info = inspection?.info;

  return (
    <div className="detail" data-testid="detail-panel">
      <div className="detail-head">
        <div className="detail-title">
          <Icon name="image" size={16} />
          <span title={item.fileName}>{item.fileName}</span>
        </div>
        <div className="detail-actions">
          <button type="button" className="btn btn-primary" onClick={onClean} disabled={busy || !inspection || Boolean(info?.unsupportedReason)} data-testid="btn-clean">
            <Icon name="sparkles" size={15} />
            {result ? '重新清理' : '清理元数据'}
          </button>
          <button type="button" className="btn" onClick={onDownload} disabled={!result} data-testid="btn-download">
            <Icon name="download" size={15} />
            下载
          </button>
          <button type="button" className="btn" onClick={onDownloadAll} disabled={batchCount === 0} data-testid="btn-download-all">
            <Icon name="archive" size={15} />
            打包 ({batchCount})
          </button>
          <button type="button" className="btn btn-subtle" onClick={onClearAll} data-testid="btn-clear-all">
            <Icon name="trash" size={15} />
            清空工作区
          </button>
        </div>
      </div>

      <div className="detail-body">
        <div className="preview-grid">
          <figure className="preview-figure">
            <div className="preview-frame">
              <img src={item.previewUrl} alt={`${item.fileName} 预览`} data-testid="preview-image" />
            </div>
            <figcaption>原始文件</figcaption>
          </figure>
          <figure className="preview-figure">
            <div className="preview-frame">
              {result ? (
                <CleanedPreview buffer={result.buffer} mime={result.mime} alt="清理后预览" />
              ) : (
                <div className="preview-placeholder">
                  <Icon name="shield" size={22} />
                  <span>清理后在这里预览</span>
                </div>
              )}
            </div>
            <figcaption>{result ? '清理后文件' : '待清理'}</figcaption>
          </figure>
        </div>

        {info ? (
          <div className="info-grid" data-testid="image-info">
            <div className="info-cell">
              <span className="info-label">格式</span>
              <span className="info-value">{info.format.toUpperCase()}</span>
            </div>
            <div className="info-cell">
              <span className="info-label">尺寸</span>
              <span className="info-value">{info.dimension ? `${info.dimension.width} × ${info.dimension.height}` : '未知'}</span>
            </div>
            <div className="info-cell">
              <span className="info-label">原始大小</span>
              <span className="info-value">{formatBytes(info.bytes)}</span>
            </div>
            <div className="info-cell">
              <span className="info-label">结构</span>
              <span className={`info-value ${info.structurallyValid ? 'ok' : 'bad'}`}>
                {info.structurallyValid ? '有效' : '异常'}
              </span>
            </div>
          </div>
        ) : null}

        {info?.unsupportedReason ? (
          <div className="banner banner-danger" data-testid="unsupported-banner">
            <Icon name="alert" size={16} />
            <div>
              <strong>这个文件无法清理元数据</strong>
              <p>{info.unsupportedReason}</p>
            </div>
          </div>
        ) : null}

        {item.error ? (
          <div className="banner banner-danger" data-testid="error-banner">
            <Icon name="alert" size={16} />
            <div>
              <strong>处理失败</strong>
              <p>{item.error}</p>
            </div>
          </div>
        ) : null}

        {inspection && inspection.risk !== 'none' ? (
          <div className={`banner banner-${riskCopy(inspection.risk).tone}`} data-testid="risk-banner">
            <Icon name={inspection.risk === 'high' ? 'alert' : 'info'} size={16} />
            <div>
              <strong>{riskCopy(inspection.risk).title}</strong>
              <p>{riskCopy(inspection.risk).body}</p>
            </div>
          </div>
        ) : null}

        {inspection?.gps ? (
          <div className="gps-card" data-testid="gps-card">
            <div className="gps-head">
              <Icon name="pin" size={16} />
              <strong>检测到精确 GPS 坐标</strong>
            </div>
            <div className="gps-values">
              <span>
                纬度 <b data-testid="gps-lat">{formatCoord(inspection.gps.latitude)}</b>
                {inspection.gps.latitudeRef ? ` ${inspection.gps.latitudeRef}` : ''}
              </span>
              <span>
                经度 <b data-testid="gps-lon">{formatCoord(inspection.gps.longitude)}</b>
                {inspection.gps.longitudeRef ? ` ${inspection.gps.longitudeRef}` : ''}
              </span>
              {typeof inspection.gps.altitude === 'number' ? <span>海拔 <b>{inspection.gps.altitude.toFixed(1)} m</b></span> : null}
            </div>
            <a className="gps-link" href={osmLink(inspection.gps.latitude, inspection.gps.longitude)} target="_blank" rel="noopener noreferrer">
              在 OpenStreetMap 查看（外链，你自己决定是否打开）
            </a>
          </div>
        ) : null}

        <section className="section">
          <h3 className="section-head">
            元数据（已检测）
            <span className="section-count">{inspection?.fields.length ?? 0}</span>
          </h3>
          <MetadataTable fields={inspection?.fields ?? []} emptyText="没有可解析的元数据字段。" />
        </section>

        <section className="section">
          <h3 className="section-head">按容器统计</h3>
          {inspection && inspection.containers.length > 0 ? (
            <div className="container-table" data-testid="container-table">
              {inspection.containers.map((container) => (
                <div className="container-row" key={container.kind}>
                  <span className="container-name">{container.kind.toUpperCase()}</span>
                  <span className="container-bytes">{formatBytes(container.bytes)}</span>
                  <span className="container-count">×{container.count}</span>
                  <span className="container-note">{container.note}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-inline">
              <Icon name="shield" size={16} />
              <span>没有检测到元数据容器。</span>
            </div>
          )}
        </section>

        <section className="section">
          <h3 className="section-head">清理选项</h3>
          <label className="option-row">
            <input
              type="checkbox"
              checked={options.keepColorProfile}
              onChange={(event) => onOptionsChange({ ...options, keepColorProfile: event.target.checked })}
              data-testid="option-icc"
            />
            <span>
              保留 ICC 色彩配置文件
              <small>不含个人信息，但删掉可能让颜色轻微偏色。默认保留。</small>
            </span>
          </label>
          <label className="option-row">
            <input
              type="checkbox"
              checked={options.stripTrailingBytes}
              onChange={(event) => onOptionsChange({ ...options, stripTrailingBytes: event.target.checked })}
              data-testid="option-trailing"
            />
            <span>
              删除文件结尾的多余字节
              <small>图像结束标记之后的数据对解码无用，常被用来夹带任意内容。</small>
            </span>
          </label>
        </section>

        {result ? (
          <section className="section" data-testid="result-section">
            <h3 className="section-head">
              清理结果
              {result.verified ? (
                <span className="chip ok">已重新解析验证</span>
              ) : (
                <span className="chip warn">无法完全验证</span>
              )}
            </h3>

            <div className="compare-grid">
              <div className="compare-cell">
                <span className="compare-label">清理前</span>
                <span className="compare-value">{formatBytes(result.bytesBefore)}</span>
              </div>
              <div className="compare-cell">
                <span className="compare-label">清理后</span>
                <span className="compare-value">{formatBytes(result.bytesAfter)}</span>
              </div>
              <div className="compare-cell">
                <span className="compare-label">像素尺寸</span>
                <span className="compare-value">
                  {result.dimension ? `${result.dimension.width} × ${result.dimension.height}` : '未知'}
                </span>
              </div>
              <div className="compare-cell">
                <span className="compare-label">格式</span>
                <span className="compare-value">{result.ext.toUpperCase()}</span>
              </div>
            </div>

            <h4 className="sub-head">已移除的容器</h4>
            {result.removed.length > 0 ? (
              <ul className="removed-list" data-testid="removed-list">
                {result.removed.map((entry) => (
                  <li key={`${entry.kind}-${entry.label}`}>
                    <span className="removed-name">{entry.label}</span>
                    <span className="removed-meta">
                      {formatBytes(entry.bytes)} · ×{entry.count}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="empty-inline">
                <Icon name="info" size={16} />
                <span>没有需要移除的元数据容器（文件本来就很干净）。</span>
              </div>
            )}

            <h4 className="sub-head">清理后重新解析出的残留</h4>
            <MetadataTable fields={result.remainingFields} emptyText="重新解析未发现残留的个人数据字段。" />

            {result.verificationNotes.length > 0 ? (
              <div className="banner banner-warn" data-testid="verify-notes">
                <Icon name="info" size={16} />
                <div>
                  <strong>验证说明</strong>
                  <ul>
                    {result.verificationNotes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : null}
          </section>
        ) : null}

        {inspection && inspection.notes.length > 0 ? (
          <section className="section">
            <h3 className="section-head">检查说明</h3>
            <ul className="notes-list" data-testid="inspection-notes">
              {inspection.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="section">
          <h3 className="section-head">能力边界（按格式）</h3>
          <p className="section-hint">
            我们不会声称「清除所有隐藏信息」。下面是按格式明确写出的能力与限制：能删的容器一定会删并验证；删不掉的部分会明确标注。
          </p>
          <div className="boundary-table" data-testid="boundary-table">
            {FORMAT_BOUNDARIES.map((row) => (
              <div className="boundary-row" key={row.format}>
                <span className="boundary-format">{row.format}</span>
                <span className="boundary-can">
                  <b>可清理</b>
                  {row.can}
                </span>
                <span className="boundary-cannot">
                  <b>无法保证</b>
                  {row.cannot}
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
