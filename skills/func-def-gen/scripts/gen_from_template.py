# -*- coding: utf-8 -*-
"""Generate a new-project function-definition docx from a template + config.json.
Usage: python gen_from_template.py <config.json>
config.json fields:
  domain, src, out, token_repl[[old,new]...], signals{key:[name,cn,val]},
  block_signals{heading2_before_repl:[key...]}, fault_text, recover_text,
  change_record_date, fill_sections[...] (default 相关信号/故障处理/故障恢复)

Default behavior: sections with no explicit signals/text in config are left as
empty skeletons (matching human-written standard answers). Only fill when the
config explicitly provides signals for that heading2 or fault/recover text.
"""
import sys, json, re
import copy
import importlib.util
import hashlib
from pathlib import Path
from docx import Document
from docx.oxml.ns import qn
from docx.oxml import OxmlElement
from docx.table import Table
from docx.text.paragraph import Paragraph


try:
    from workflow_contract import (
        WorkflowContractError,
        contract_to_legacy_config,
        normalize_workflow_contract,
    )
except ModuleNotFoundError:  # pragma: no cover - direct file loading in tests
    _contract_spec = importlib.util.spec_from_file_location(
        'func_def_workflow_contract', Path(__file__).with_name('workflow_contract.py')
    )
    if _contract_spec is None or _contract_spec.loader is None:
        raise
    _contract_module = importlib.util.module_from_spec(_contract_spec)
    _contract_spec.loader.exec_module(_contract_module)
    WorkflowContractError = _contract_module.WorkflowContractError
    contract_to_legacy_config = _contract_module.contract_to_legacy_config
    normalize_workflow_contract = _contract_module.normalize_workflow_contract


SKILL_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DOMAIN = 'cockpit'
TEMPLATE_REGISTRY = SKILL_ROOT / 'assets' / 'template_registry.json'
MODULE_SUBSECTIONS = {
    '本功能涉及的法规内容', '功能逻辑架构图', '功能描述', '使能条件',
    '配置字', '触发条件', '执行输出', 'HMI要求', '退出条件',
    '故障处理', '故障恢复', '相关信号',
}
CORE_CONTENT_SECTIONS = (
    '功能描述', '使能条件', '触发条件', '执行输出', 'HMI要求', '退出条件',
)


def _domain_entry(domain):
    requested = str(domain or DEFAULT_DOMAIN).strip().lower()
    resolved, entry = _resolve_domain(requested)
    return resolved, entry


def _module_schema(domain):
    resolved, entry = _domain_entry(domain)
    section_names = entry.get('module_section_headings')
    required = entry.get('required_sections')
    if not isinstance(section_names, list) or not section_names:
        raise RuntimeError(f'模板注册项缺少 module_section_headings: {resolved}')
    if not isinstance(required, list) or not required:
        raise RuntimeError(f'模板注册项缺少 required_sections: {resolved}')
    return {
        'domain': resolved,
        'area_heading': str(entry.get('module_area_heading') or '系统功能描述').strip(),
        'module_style': str(entry.get('module_heading_style') or 'Heading 3').strip(),
        'section_style': str(entry.get('section_heading_style') or 'Heading 3').strip(),
        'section_names': {str(item).strip().rstrip('：:').strip() for item in section_names if str(item).strip()},
        'required_sections': tuple(str(item).strip() for item in required if str(item).strip()),
    }


def _template_registry():
    try:
        with TEMPLATE_REGISTRY.open(encoding='utf-8') as registry_file:
            registry = json.load(registry_file)
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f'功能定义模板注册表不可读: {TEMPLATE_REGISTRY}') from exc
    templates = registry.get('templates')
    if not isinstance(templates, dict) or not templates:
        raise RuntimeError(f'功能定义模板注册表为空: {TEMPLATE_REGISTRY}')
    return templates


def _resolve_domain(domain):
    requested = str(domain or DEFAULT_DOMAIN).strip().lower()
    templates = _template_registry()
    if requested in templates:
        entry = templates[requested]
        if not isinstance(entry, dict) or str(entry.get('domain', requested)).strip().lower() != requested:
            raise RuntimeError(f'模板注册项域标识不匹配: {requested}')
        return requested, entry
    for key, entry in templates.items():
        aliases = entry.get('aliases', []) if isinstance(entry, dict) else []
        if requested in {str(alias).strip().lower() for alias in aliases}:
            if str(entry.get('domain', key)).strip().lower() != key:
                raise RuntimeError(f'模板注册项域标识不匹配: {key}')
            return key, entry
    supported = '、'.join(sorted(templates))
    raise ValueError(f'不支持的功能定义领域: {domain}；可选领域: {supported}')


def resolve_source(cfg):
    """Resolve an explicit template or a registered domain template.

    ``src`` remains an escape hatch for a user-confirmed task-local template.
    Without it, the domain registry is authoritative.  A missing registered
    asset is an error; it must not silently fall back to another domain's
    template.
    """
    if cfg.get('src'):
        source = Path(cfg['src']).expanduser()
    else:
        domain, entry = _resolve_domain(cfg.get('domain'))
        relative_path = entry.get('path') if isinstance(entry, dict) else None
        if not relative_path:
            raise RuntimeError(f'功能定义领域缺少模板路径: {domain}')
        source = SKILL_ROOT / 'assets' / relative_path
    if not source.is_file():
        raise FileNotFoundError(f'功能定义模板不存在: {source}')
    return source


def template_selection_metadata(cfg):
    """Return the auditable template decision used by a generation run."""
    requested_domain = cfg.get('domain') or DEFAULT_DOMAIN
    resolved_domain, entry = _resolve_domain(requested_domain)
    source = resolve_source(cfg)
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    explicit = bool(cfg.get('src'))
    return {
        'domain': resolved_domain,
        'template_id': str(entry.get('template_id') or '').strip(),
        'path': str(source.resolve()),
        'source': 'user_explicit' if explicit else 'template_registry',
        'source_reason': str(cfg.get('src_reason') or '').strip() if explicit else '',
        'sha256': digest,
        'version': str(entry.get('version') or entry.get('template_version') or 'unknown'),
        'status': str(entry.get('status') or 'active'),
    }


def _write_json_artifact(path, value):
    destination = Path(path).expanduser()
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def _registered_fill_sections(cfg):
    """Return domain-specific anchors while preserving cockpit defaults."""
    if cfg.get('fill_sections') is not None:
        return cfg['fill_sections']
    try:
        _, entry = _resolve_domain(cfg.get('domain'))
    except (ValueError, RuntimeError):
        return ['相关信号', '故障处理', '故障恢复']
    sections = entry.get('fill_sections') if isinstance(entry, dict) else None
    return sections or ['相关信号', '故障处理', '故障恢复']


def _unresolved_items(cfg):
    items = cfg.get('unresolved_items', [])
    if not isinstance(items, list):
        raise ValueError('unresolved_items 必须是数组')
    return [item for item in items if isinstance(item, dict)]


def _append_generation_state(doc, mode, unresolved):
    """Make draft uncertainty visible in the document instead of inventing facts."""
    if mode != 'draft':
        return
    status = doc.add_paragraph()
    status.style = doc.styles['Heading 1'] if 'Heading 1' in doc.styles else None
    status.add_run('文档状态：草案')
    doc.add_paragraph('本稿允许存在尚未由人确认的内容；待确认项不得视为正式项目结论。')
    if not unresolved:
        return
    heading = doc.add_paragraph()
    heading.style = doc.styles['Heading 1'] if 'Heading 1' in doc.styles else None
    heading.add_run('待确认项')
    table = doc.add_table(rows=1, cols=4)
    try:
        table.style = doc.styles['Table Grid']
    except Exception:
        pass
    headers = ['事项', '状态', '说明', '来源']
    for cell, label in zip(table.rows[0].cells, headers):
        cell.text = label
    for item in unresolved:
        cells = table.add_row().cells
        cells[0].text = str(item.get('topic', '')).strip()
        cells[1].text = str(item.get('status', 'pending')).strip()
        cells[2].text = str(item.get('detail', '')).strip()
        cells[3].text = str(item.get('source', '')).strip()


def _normalized_heading(text):
    return str(text or '').strip().rstrip('：:').strip()


def _body_blocks(doc):
    """Yield body blocks in document order without unstable paragraph indexes."""
    for child in doc.element.body.iterchildren():
        if child.tag == qn('w:p'):
            paragraph = Paragraph(child, doc)
            yield 'paragraph', paragraph, paragraph.text.strip()
        elif child.tag == qn('w:tbl'):
            table = Table(child, doc)
            text = '\n'.join(cell.text for row in table.rows for cell in row.cells).strip()
            yield 'table', table, text


def _feature_modules(doc, domain=None):
    """Locate cockpit feature modules whose module and subsection headings are H3.

    A module title is an H3 that is not one of the reusable subsection anchors.
    Paragraph objects retain their underlying OOXML node, so later insertions do
    not invalidate the anchors the way ``doc.paragraphs[index]`` does.
    """
    schema = _module_schema(domain)
    modules = []
    current_module = None
    current_section = None
    in_feature_area = False
    for kind, block, text in _body_blocks(doc):
        if kind == 'paragraph':
            style = block.style.name if block.style else ''
            heading = _normalized_heading(text)
            if style == 'Heading 1':
                in_feature_area = heading == schema['area_heading']
                current_module = None
                current_section = None
                continue
            if not in_feature_area:
                continue
            if style.startswith('Heading'):
                if style == schema['section_style'] and heading in schema['section_names'] and current_module is not None:
                    current_section = {
                        'title': heading,
                        'anchor': block,
                        'content': [],
                    }
                    current_module['sections'][heading] = current_section
                    continue
                if style == schema['module_style'] and heading:
                    current_module = {
                        'title': heading,
                        'anchor': block,
                        'sections': {},
                    }
                    modules.append(current_module)
                    current_section = None
                    continue
                current_section = None
                continue
        if current_section is not None and text:
            current_section['content'].append(text)
    return modules


def _insert_body_paragraph(anchor, text):
    paragraph = OxmlElement('w:p')
    properties = OxmlElement('w:pPr')
    style = OxmlElement('w:pStyle')
    style.set(qn('w:val'), 'Normal')
    properties.append(style)
    paragraph.append(properties)
    run = OxmlElement('w:r')
    value = OxmlElement('w:t')
    value.set(qn('xml:space'), 'preserve')
    value.text = str(text)
    run.append(value)
    paragraph.append(run)
    anchor._p.addnext(paragraph)


def _fill_section_content(doc, section_content, domain=None):
    if not section_content:
        return 0
    if not isinstance(section_content, dict):
        raise ValueError('section_content 必须是“模块名 -> 小节名 -> 正文”的对象')
    modules = {module['title']: module for module in _feature_modules(doc, domain)}
    filled = 0
    for module_title, sections in section_content.items():
        module = modules.get(_normalized_heading(module_title))
        if module is None:
            raise ValueError(f'未找到功能模块: {module_title}')
        if not isinstance(sections, dict):
            raise ValueError(f'模块正文必须是对象: {module_title}')
        for section_title, content in sections.items():
            section = module['sections'].get(_normalized_heading(section_title))
            if section is None:
                raise ValueError(f'模块“小节”不存在: {module_title}/{section_title}')
            text = str(content or '').strip()
            if not text:
                continue
            _insert_body_paragraph(section['anchor'], text)
            filled += 1
    return filled


def inspect_document_structure(document, target_sections=None, domain=None):
    """Return a machine-readable completeness result for feature-module bodies."""
    # ``Document`` is a factory function rather than an exposed class; use its
    # stable public capability to accept either an already-open document or a
    # path-like input.
    doc = document if hasattr(document, 'element') else Document(document)
    if target_sections is None:
        target_sections = _module_schema(domain)['required_sections']
    target_sections = tuple(_normalized_heading(item) for item in target_sections)
    modules = _feature_modules(doc, domain)
    empty = []
    filled = []
    for module in modules:
        for section_name in target_sections:
            section = module['sections'].get(section_name)
            record = f"{module['title']}/{section_name}"
            if section is not None and section['content']:
                filled.append(record)
            else:
                empty.append(record)
    total = len(modules) * len(target_sections)
    return {
        'module_count': len(modules),
        'target_section_count': total,
        'filled_section_count': len(filled),
        'empty_section_count': len(empty),
        'coverage': (len(filled) / total) if total else 0.0,
        'filled_sections': filled,
        'empty_sections': empty,
    }


def _clone_feature_chapters(doc, feature_chapters):
    """Clone the single reusable feature chapter for each requested feature.

    The template contains one ``功能模块 1`` chapter.  A config can provide
    ``feature_chapters`` as a list of ``{"title": ..., "signals": ...}``.
    The first item reuses the template chapter and later items clone its OOXML
    block, preserving all styles, drawings and anchor headings.
    """
    if not feature_chapters:
        return
    if not isinstance(feature_chapters, list) or not all(isinstance(x, dict) for x in feature_chapters):
        raise ValueError('feature_chapters 必须是对象数组')
    body = doc.element.body
    children = list(body.iterchildren())
    module_h2 = None
    start = None
    end = None
    for index, child in enumerate(children):
        if child.tag != qn('w:p'):
            continue
        para = Paragraph(child, doc)
        text = para.text.strip()
        style = para.style.name if para.style else ''
        if style == 'Heading 2' and text in {'功能模块', '功能模块 1'}:
            module_h2 = child
            start = index + 1
            continue
        # The reusable chapter is the remainder of the body.  Do not stop at
        # its Heading 3 subsection anchors (法规、功能描述、相关信号等).
    if module_h2 is None or start is None:
        raise ValueError('模板中缺少可复制的功能模块章节')
    if end is None:
        end = len(children)
    block = [node for node in children[start:end] if node.tag != qn('w:sectPr')]
    if not block:
        raise ValueError('模板中的功能模块章节为空')

    def set_first_heading(cloned, title):
        for node in cloned.iter():
            if node.tag != qn('w:p'):
                continue
            para = Paragraph(node, doc)
            style = para.style.name if para.style else ''
            if style == 'Heading 3':
                if para.text.strip():
                    for run in para.runs:
                        run.text = ''
                    para.runs[0].text = title if para.runs else ''
                    if not para.runs:
                        para.add_run(title)
                    return

    # Apply the first title and clone the complete feature block for the rest.
    first_title = str(feature_chapters[0].get('title') or '功能模块 1').strip()
    set_first_heading(block[0], first_title)
    insertion_point = block[-1]
    for item in feature_chapters[1:]:
        cloned_nodes = [copy.deepcopy(node) for node in block]
        title = str(item.get('title') or f'功能模块 {feature_chapters.index(item) + 1}').strip()
        set_first_heading(cloned_nodes[0], title)
        for node in cloned_nodes:
            body.insert(body.index(insertion_point) + 1, node)
            insertion_point = node
    return feature_chapters


def generate(config_path):
    with Path(config_path).open(encoding='utf-8') as config_file:
        cfg = json.load(config_file)
    contract = normalize_workflow_contract(cfg)
    if contract is not None:
        cfg = contract_to_legacy_config(cfg, contract)
    selection = template_selection_metadata(cfg)
    selection_path = cfg.get('template_selection_path')
    if selection_path:
        _write_json_artifact(selection_path, selection)
    mode = str(cfg.get('mode', 'final')).strip().lower()
    if mode not in {'draft', 'final'}:
        raise ValueError('mode 只能是 draft 或 final')
    unresolved = _unresolved_items(cfg)
    if mode == 'final' and unresolved:
        topics = '、'.join(str(item.get('topic', '未命名事项')) for item in unresolved)
        raise ValueError(f'正式版仍有未决项: {topics}')
    doc = Document(resolve_source(cfg))
    _clone_feature_chapters(doc, cfg.get('feature_chapters'))
    domain = cfg.get('domain') or DEFAULT_DOMAIN
    _fill_section_content(doc, cfg.get('section_content'), domain)
    REPL = [(o, n) for o, n in cfg.get('token_repl', [])]
    SIGNALS = cfg.get('signals', {})
    BLOCK_SIG = cfg.get('block_signals', {})
    FAULT = cfg.get('fault_text', '')
    RECOVER = cfg.get('recover_text', '')
    sections = _registered_fill_sections(cfg)

    # ---- collect anchors (before any replacement so h2 titles match config) ----
    anchor_map = {s: [] for s in sections}  # section -> [(para, h2, existing_tbl_or_None)]
    current_h2 = None
    body = doc.element.body
    for child in list(body.iterchildren()):
        if child.tag == qn('w:p'):
            p = Paragraph(child, doc)
            style = p.style.name if p.style else ''
            txt = p.text.strip()
            if style == 'Heading 2':
                current_h2 = txt
            elif style in {'Heading 3', 'Heading 4'}:
                # tolerate trailing colon variants (相关信号： / 故障处理： etc.)
                h3 = txt.rstrip('：:').strip()
                if h3 in anchor_map:
                    nxt = child.getnext()
                    existing = Table(nxt, doc) if (nxt is not None and nxt.tag == qn('w:tbl')) else None
                    anchor_map[h3].append((p, current_h2, existing))

    # ---- insert helpers ----
    def norm(n):
        # normalize an existing signal name the same way global REPL will rename it
        res = n
        for o, nn in REPL:
            if o in res:
                res = res.replace(o, nn)
        return res

    def insert_signal_table(anchor_p, h2):
        keys = BLOCK_SIG.get(h2)
        if not keys:
            # no signals specified for this section -> leave empty (do not insert placeholder)
            return
        tbl = doc.add_table(rows=1, cols=3)
        try:
            tbl.style = doc.styles['Table Grid']
        except Exception:
            pass
        hdr = tbl.rows[0].cells
        hdr[0].text = '信号名称'; hdr[1].text = '中文信号描述'; hdr[2].text = '信号值描述'
        for k in keys:
            name, cn, val = SIGNALS[k]
            c = tbl.add_row().cells
            c[0].text = name; c[1].text = cn; c[2].text = val
        anchor_p._p.addnext(tbl._tbl)

    def append_signal_rows(existing_tbl, h2):
        ncols = len(existing_tbl.columns)
        present = set()
        for row in existing_tbl.rows:
            cs = row.cells
            if len(cs) > 1:
                present.add(norm(cs[1].text.strip()))
            elif cs:
                present.add(norm(cs[0].text.strip()))
        for k in BLOCK_SIG.get(h2, []):
            name, cn, val = SIGNALS[k]
            if norm(name) in present:
                continue
            cells = existing_tbl.add_row().cells
            for i in range(ncols):
                if i == 1:
                    cells[i].text = name
                elif i == 2:
                    cells[i].text = cn
                elif i == 3:
                    cells[i].text = val
                else:
                    cells[i].text = ''
            present.add(name)

    def insert_text_after(anchor_p, text):
        new_p = OxmlElement('w:p')
        r = OxmlElement('w:r')
        t = OxmlElement('w:t')
        t.set(qn('xml:space'), 'preserve')
        t.text = text
        r.append(t); new_p.append(r)
        anchor_p._p.addnext(new_p)

    signal_sections = [name for name in ('相关信号', '接口') if name in anchor_map]
    for section_name in signal_sections:
        for p, h2, existing in anchor_map[section_name]:
            if existing is not None:
                append_signal_rows(existing, h2)
            else:
                insert_signal_table(p, h2)
    fault_sections = [name for name in ('故障处理', '故障定义') if name in anchor_map]
    for section_name in fault_sections:
        for p, h2, _ in anchor_map[section_name]:
            if FAULT:
                insert_text_after(p, FAULT)
    if '故障恢复' in anchor_map:
        for p, h2, _ in anchor_map['故障恢复']:
            if RECOVER:
                insert_text_after(p, RECOVER)

    # ---- global token replacement ----
    def replace_in_element(el):
        runs = []
        if hasattr(el, 'paragraphs'):
            for para in el.paragraphs:
                runs.extend(para.runs)
        else:
            runs = el.runs
        if not runs:
            return
        full = ''.join(r.text for r in runs)
        orig = full
        for old, new in REPL:
            if old in full:
                full = full.replace(old, new)
        if full != orig:
            runs[0].text = full
            for r in runs[1:]:
                r.text = ''

    for para in doc.paragraphs:
        replace_in_element(para)
    for tbl in doc.tables:
        for row in tbl.rows:
            for cell in row.cells:
                replace_in_element(cell)
    for section in doc.sections:
        for part in (section.header, section.footer):
            for para in part.paragraphs:
                replace_in_element(para)
            for tbl in part.tables:
                for row in tbl.rows:
                    for cell in row.cells:
                        replace_in_element(cell)

    # ---- update change-record table date ----
    crd = cfg.get('change_record_date')
    if crd:
        for tbl in doc.tables:
            hit = False
            for row in tbl.rows:
                for c in row.cells:
                    if ('项目' in c.text) and ('功能定义' in c.text or 'OTA' in c.text):
                        for cc in row.cells:
                            if re.match(r'^\s*20\d{2}[.\-/]', cc.text) or cc.text.strip() == '':
                                cc.text = crd
                                break
                        hit = True
                        break
                if hit:
                    break
            if hit:
                break

    _append_generation_state(doc, mode, unresolved)
    output = Path(cfg['out']).expanduser()
    output.parent.mkdir(parents=True, exist_ok=True)
    stats = inspect_document_structure(doc, domain=domain)
    if mode == 'final' and cfg.get('feature_chapters') and stats['empty_section_count']:
        preview = '、'.join(stats['empty_sections'][:5])
        raise ValueError(
            f"正式版核心正文为空: {stats['empty_section_count']}/"
            f"{stats['target_section_count']} 小节；示例: {preview}"
        )
    doc.save(output)
    print("SAVED:", output)
    print(
        "  完整性: "
        f"模块={stats['module_count']} "
        f"正文={stats['filled_section_count']}/{stats['target_section_count']}"
    )
    for s in sections:
        print(f"  {s}: {len(anchor_map[s])} subsections handled")
    return output


def main():
    generate(sys.argv[1])

if __name__ == '__main__':
    main()
