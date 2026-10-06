import { useEffect, useId, useRef, useState } from 'react'
import { Alert, AutoComplete, Button, Empty, Form, Input, Modal, Select, Space, Spin, Table, Typography, Drawer, Descriptions } from 'antd'
import type { FormInstance, TableProps } from 'antd'
import { Audit, request } from './api'

export function ModelPicker({ value, onChange, form, configurationId, apiKeyConfigured }: { value?: string; onChange?: (value: string) => void; form: FormInstance; configurationId?: string; apiKeyConfigured?: boolean }) {
  const baseUrl = Form.useWatch('baseUrl', form); const apiKey = Form.useWatch('apiKey', form)
  const [models, setModels] = useState<string[]>([]); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [open, setOpen] = useState(false)
  const revision = useRef(0)
  const loadedSource = useRef('')
  useEffect(() => { if (loadedSource.current === JSON.stringify([baseUrl, apiKey, configurationId])) return; revision.current++; setModels([]); setError(''); setOpen(false); setBusy(false) }, [baseUrl, apiKey, configurationId])
  useEffect(() => () => { revision.current++ }, [])
  const discover = async () => {
    const current = ++revision.current; setBusy(true); setError('')
    try {
      await form.validateFields(['baseUrl'])
      const result = await request<{ models: string[]; baseUrl: string }>('/models/discover', { id: configurationId, baseUrl: form.getFieldValue('baseUrl'), apiKey: form.getFieldValue('apiKey') })
      if (revision.current !== current) return
      loadedSource.current = JSON.stringify([result.baseUrl, apiKey, configurationId]); form.setFieldValue('baseUrl', result.baseUrl)
      setModels(result.models); setOpen(result.models.length > 0); if (!result.models.length) setError('供应商返回了空模型列表，可以手动填写模型名称。')
    } catch (reason) { if (revision.current === current) setError(reason instanceof Error ? reason.message : '请填写正确的服务地址') }
    finally { if (revision.current === current) setBusy(false) }
  }
  return <div className="model-picker"><div className="model-picker-row"><AutoComplete aria-label="模型名称" value={value} onChange={onChange} options={models.map(id => ({ value: id }))} virtual={false} open={open} onOpenChange={setOpen} onFocus={() => setOpen(!!models.length)} onSelect={() => setOpen(false)} filterOption={(query, option) => String(option?.value).toLowerCase().includes(query.toLowerCase())} placeholder="拉取后选择，也可手动输入" /><Button loading={busy} disabled={!baseUrl || (!apiKey && !apiKeyConfigured)} onClick={discover}>拉取模型列表</Button></div>{error && <Alert type="warning" title={error} />}{models.length > 0 && <Typography.Text type="secondary">已拉取 {models.length} 个模型，可搜索选择。</Typography.Text>}</div>
}

type CoverImage = { id: string; url: string; prompt: string }
type ImageModel = { id: string; name: string; model: string; isDefault: boolean }
export function CoverPicker({ value, onChange, form }: { value?: string; onChange?: (value: string) => void; form: FormInstance }) {
  const input = useRef<HTMLInputElement>(null); const alive = useRef(true); const promptId = useId(); const modelId = useId()
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [mode, setMode] = useState<'library' | 'generate' | null>(null)
  const [images, setImages] = useState<CoverImage[]>([]); const [models, setModels] = useState<ImageModel[]>([]); const [selectedModel, setSelectedModel] = useState(''); const [prompt, setPrompt] = useState(''); const [generated, setGenerated] = useState<CoverImage | null>(null); const [loading, setLoading] = useState(false)
  const retry = useRef<{ payload: string; id: string } | null>(null)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const upload = async (file: File) => {
    setBusy(true); setError('')
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error('封面图片最大 8MB')
      const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('读取图片失败')); reader.readAsDataURL(file) })
      const image = await request<CoverImage>('/characters/cover/upload', { name: file.name, base64: dataUrl.split(',')[1] })
      if (alive.current) onChange?.(image.url)
    } catch (reason) { if (alive.current) setError((reason as Error).message) }
    finally { if (alive.current) setBusy(false); if (input.current) input.current.value = '' }
  }
  const show = async (next: 'library' | 'generate') => {
    setMode(next); setError(''); setLoading(true); setGenerated(null)
    if (next === 'generate') { const fields = form.getFieldsValue(); setPrompt(`${fields.name || '原创角色'}，${String(fields.description || '精美人物肖像，适合作为角色卡封面').slice(0, 1000)}，竖向人物构图，无文字`); retry.current = null }
    try {
      if (next === 'library') setImages(await request<CoverImage[]>('/characters/cover/images'))
      else { const available = await request<ImageModel[]>('/characters/cover/models'); setModels(available); setSelectedModel((available.find(item => item.isDefault) || available[0])?.id || '') }
    } catch (reason) { if (alive.current) setError((reason as Error).message) }
    finally { if (alive.current) setLoading(false) }
  }
  const generate = async () => {
    const payload = JSON.stringify({ prompt, modelId: selectedModel }); if (!retry.current || retry.current.payload !== payload) retry.current = { payload, id: crypto.randomUUID() }
    setBusy(true); setError('')
    try { const result = await request<CoverImage>('/characters/cover/generate', { prompt, modelId: selectedModel, requestId: retry.current.id }, 'POST', 150000); if (alive.current) setGenerated(result) }
    catch (reason) { if (alive.current) setError((reason as Error).message) }
    finally { if (alive.current) setBusy(false) }
  }
  const choose = (image: CoverImage) => { onChange?.(image.url); setMode(null); setError('') }
  const embedded = value?.startsWith('data:image/')
  return <div className="cover-picker">{value && <img className="cover-preview" src={value} alt="角色封面预览" />}<Input aria-label="封面地址" value={embedded ? '' : value} onChange={event => onChange?.(event.target.value)} placeholder={embedded ? '已选择图片，也可输入地址替换' : 'https://... 或 /art/...'} />{embedded && <Typography.Text type="secondary">图片已选择，保存角色后生效。</Typography.Text>}<Space wrap><Button loading={busy && !mode} disabled={busy} onClick={() => input.current?.click()}>上传图片</Button><Button disabled={busy} onClick={() => show('library')}>选择已有图片</Button><Button disabled={busy} onClick={() => show('generate')}>AI 生成封面</Button></Space><input ref={input} hidden type="file" accept="image/png,image/jpeg,image/webp" aria-label="上传角色封面" onChange={event => { const file = event.target.files?.[0]; if (file) upload(file) }} />{error && !mode && <Alert type="error" title={error} />}<Modal title={mode === 'library' ? '选择已有图片' : 'AI 生成角色封面'} open={!!mode} onCancel={() => setMode(null)} closable={!busy} mask={{ closable: !busy }} keyboard={!busy} footer={null} destroyOnHidden width={700}>{error && <Alert type="error" title={error} />}{loading ? <Spin /> : mode === 'library' ? images.length ? <div className="cover-library">{images.map(image => <button type="button" key={image.id} onClick={() => choose(image)} aria-label={`选择图片 ${image.prompt}`}><img src={image.url} alt={image.prompt} /><span>{image.prompt}</span></button>)}</div> : <Empty description="暂无图片，可先上传或生成封面" /> : <div className="cover-generation"><label htmlFor={modelId}>生图模型</label><Select id={modelId} virtual={false} value={selectedModel || undefined} onChange={setSelectedModel} disabled={busy} options={models.map(item => ({ value: item.id, label: `${item.name} · ${item.model}` }))} placeholder="请选择后台已配置的生图模型" />{!models.length && <Alert type="info" title="请先在「模型与计费」中配置并启用生图模型。" />}<label htmlFor={promptId}>封面描述</label><Input.TextArea id={promptId} value={prompt} disabled={busy} onChange={event => { setPrompt(event.target.value); setGenerated(null) }} maxLength={2000} rows={4} showCount /><Typography.Text type="secondary">角色素材生成不扣用户积分，供应商可能收取生成费用。</Typography.Text><Button type="primary" loading={busy} disabled={!selectedModel || !prompt.trim() || !!generated} onClick={generate}>生成封面</Button>{generated && <><img className="generated-cover" src={generated.url} alt="生成的角色封面" /><Space><Button type="primary" onClick={() => choose(generated)}>使用此封面</Button><Button onClick={() => { setGenerated(null); retry.current = null }}>重新生成</Button></Space></>}</div>}</Modal></div>
}

export function AuditLogPage({ items, exportRows }: { items: Audit[]; exportRows: (rows: Record<string, unknown>[]) => void }) {
  const [query, setQuery] = useState(''); const [detail, setDetail] = useState<Audit | null>(null)
  const rows = items.filter(item => [item.actor, item.actionLabel, item.action, item.targetLabel, item.targetAccount, item.reason].join(' ').includes(query))
  const date = (value: string) => new Date(value).toLocaleString('zh-CN')
  const columns: TableProps<Audit>['columns'] = [{ title: '时间', dataIndex: 'createdAt', render: date }, { title: '操作人账号', dataIndex: 'actor' }, { title: '操作', dataIndex: 'actionLabel' }, { title: '操作对象', dataIndex: 'targetLabel' }, { title: '关联账号', dataIndex: 'targetAccount', render: value => value || '—' }, { title: '原因', dataIndex: 'reason' }, { title: '操作详情', render: (_, item) => <Button type="link" onClick={() => setDetail(item)}>查看详情</Button> }]
  return <div className="page-stack"><div className="page-heading"><div><Typography.Title level={2}>操作日志</Typography.Title><Typography.Text type="secondary">按账号查看操作人和用户对象，角色、模型及套餐显示名称。</Typography.Text></div><Button disabled={!rows.length} onClick={() => exportRows(rows.map(item => ({ 时间: date(item.createdAt), 操作人账号: item.actor, 操作: item.actionLabel, 操作对象: item.targetLabel, 关联账号: item.targetAccount, 原因: item.reason })))}>导出 CSV</Button></div><div className="audit-table-panel"><Input.Search placeholder="搜索账号、中文操作或对象" className="table-search" value={query} onChange={event => setQuery(event.target.value)} /><Table rowKey="id" size="middle" columns={columns} dataSource={rows} scroll={{ x: 1050 }} pagination={{ pageSize: 10, showSizeChanger: true, showTotal: total => `共 ${total} 条` }} /></div><Drawer title="操作详情" open={!!detail} onClose={() => setDetail(null)} size="large">{detail && <><Descriptions column={1} items={[{ key: 'actor', label: '操作人账号', children: detail.actor }, { key: 'action', label: '操作', children: detail.actionLabel }, { key: 'target', label: '操作对象', children: detail.targetLabel }, { key: 'account', label: '关联账号', children: detail.targetAccount || '—' }, { key: 'time', label: '时间', children: date(detail.createdAt) }, { key: 'reason', label: '原因', children: detail.reason || '—' }]} /><Typography.Title level={5}>修改前</Typography.Title><pre className="json-detail">{JSON.stringify(detail.before, null, 2)}</pre><Typography.Title level={5}>修改后</Typography.Title><pre className="json-detail">{JSON.stringify(detail.after, null, 2)}</pre></>}</Drawer></div>
}
