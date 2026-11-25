function setupTickets(container, api, perform, returnToMenu, visibleText) {
  const statuses = { open: 'باز', in_progress: 'در حال بررسی', waiting_customer: 'منتظر پاسخ مشتری', resolved: 'حل‌شده', closed: 'بسته' };
  const priorities = { low: 'کم', normal: 'عادی', high: 'زیاد', urgent: 'فوری' };
  const messageKinds = { staff: 'پاسخ پشتیبانی', customer: 'پیام مشتری', note: 'یادداشت داخلی', event: 'تاریخچهٔ تغییرات' };
  const finished = new Set(['closed', 'resolved']);
  const number = new Intl.NumberFormat('fa-IR');
  const date = new Intl.DateTimeFormat('fa-IR', { dateStyle: 'short', timeStyle: 'short' });
  const block = (tag, text = '', className = '') => {
    const node = document.createElement(tag);
    if (text) node.textContent = visibleText(text);
    if (className) node.className = className;
    return node;
  };
  let staff = false;
  let view = 'list';
  let options = { departments: [], staff: [] };
  let filters = {};
  let rows = [];
  let next = null;
  let ticketId = null;
  let current;

  const route = suffix => (staff ? 'admin/tickets' : 'tickets') + suffix;
  const button = (label, handler, primary = false) => {
    const control = block('button', label, primary ? '' : 'secondary');
    control.type = 'button';
    control.addEventListener('click', () => { void perform(handler); });
    return control;
  };
  const submit = label => {
    const control = block('button', label);
    control.type = 'submit';
    return control;
  };
  function field(label, control) {
    const wrapper = block('label', '', 'ticket-field');
    wrapper.append(block('span', label), control);
    return wrapper;
  }
  function select(values, value) {
    const control = document.createElement('select');
    for (const [key, label] of values) control.add(new Option(visibleText(label), key));
    if (value !== undefined) control.value = String(value);
    return control;
  }
  function input(value, max, multiline = false) {
    const control = document.createElement(multiline ? 'textarea' : 'input');
    control.value = value;
    control.maxLength = max;
    if (multiline) control.rows = 4;
    return control;
  }
  function form(...children) {
    const element = block('form', '', 'ticket-form');
    element.append(...children);
    return element;
  }
  function onSubmit(element, handler) {
    element.addEventListener('submit', event => {
      event.preventDefault();
      void perform(handler);
    });
  }
  function toolbar(title, actions) {
    const bar = block('div', '', 'ticket-toolbar');
    const buttons = block('div', '', 'actions');
    buttons.append(...actions);
    bar.append(block('h2', title), buttons);
    container.replaceChildren(bar);
  }

  async function loadOptions() {
    options = await api(route('/departments'));
  }

  async function list(append = false) {
    const params = new URLSearchParams(filters);
    if (append && next) params.set('before', next);
    const result = await api(route('?' + params));
    view = 'list';
    rows = append ? [...rows, ...result.tickets] : result.tickets;
    next = result.next;
    renderList();
  }

  function renderList() {
    toolbar(staff ? 'مدیریت تیکت‌ها' : 'تیکت‌های من', [
      staff ? button('مدیریت دپارتمان‌ها', departmentList, true) : button('ثبت تیکت جدید', createView, true),
      button(staff ? 'بازگشت به پنل' : 'بازگشت به منو', returnToMenu),
    ]);
    const status = select([['', 'همهٔ وضعیت‌ها'], ['active', 'تیکت‌های در جریان'], ...Object.entries(statuses)], filters.status);
    const department = select([['', 'همهٔ دپارتمان‌ها'], ...options.departments.map(unit => [unit.id, unit.name])], filters.department);
    const assignment = select([['', 'همه'], ['mine', 'ارجاع‌شده به من'], ['unassigned', 'بدون مسئول']], filters.assignment);
    const search = input(filters.q || '', 120);
    const fields = [field('وضعیت', status)];
    if (staff) fields.push(field('دپارتمان', department), field('ارجاع', assignment), field('موضوع، نام کاربری یا شمارهٔ تیکت', search));
    const bar = form(...fields, submit('اعمال فیلتر'));
    bar.classList.add('ticket-filters');
    onSubmit(bar, async () => {
      filters = { status: status.value };
      if (staff) Object.assign(filters, { department: department.value, assignment: assignment.value, q: search.value.trim() });
      await list();
    });
    container.append(bar);
    if (!rows.length) container.append(block('p', 'تیکتی برای این انتخاب پیدا نشد.', 'ticket-empty'));
    const results = block('ul', '', 'ticket-list');
    for (const ticket of rows) {
      const item = block('li');
      const control = button(ticket.subject, () => openThread(ticket.id));
      control.classList.add('ticket-subject');
      item.append(control, block('span', '#' + number.format(ticket.id) + ' · ' + ticket.department, 'ticket-meta'));
      item.append(block('span', statuses[ticket.status], 'ticket-pill'), block('time', date.format(ticket.updated_at), 'ticket-meta'));
      if (staff) item.append(block('span', ticket.customer + ' · ' + priorities[ticket.priority] + ' · ' + (ticket.assignee || 'بدون ارجاع'), 'ticket-meta'));
      results.append(item);
    }
    container.append(results);
    if (next) container.append(button('تیکت‌های قدیمی‌تر', () => list(true)));
  }

  function createView() {
    view = 'create';
    toolbar('ثبت تیکت جدید', [button('بازگشت به تیکت‌ها', () => list())]);
    if (!options.departments.length) {
      container.append(block('p', 'در حال حاضر دپارتمان فعالی برای ثبت تیکت وجود ندارد.'));
      return;
    }
    const unit = select(options.departments.map(department => [department.id, department.name]));
    const description = block('p', '', 'ticket-meta');
    const describe = () => { description.textContent = visibleText(options.departments.find(department => String(department.id) === unit.value)?.description || ''); };
    unit.addEventListener('change', describe);
    describe();
    const subject = input('', 120);
    const message = input('', 4000, true);
    subject.required = message.required = true;
    const editor = form(field('دپارتمان', unit), description, field('موضوع', subject), field('متن درخواست', message), submit('ثبت تیکت'));
    onSubmit(editor, async () => {
      const { id } = await api(route(''), { department: Number(unit.value), subject: subject.value, message: message.value });
      await openThread(id);
      return 'تیکت ثبت شد.';
    });
    container.append(editor);
  }

  function renderMessages(entries, append) {
    const thread = append ? container.querySelector('.ticket-thread') : block('div', '', 'ticket-thread');
    const cards = entries.map(entry => {
      const card = block('article', '', 'ticket-message');
      card.dataset.kind = entry.kind;
      const header = block('header', '', 'ticket-meta');
      header.append(block('strong', messageKinds[entry.kind]), block('span', entry.author), block('time', date.format(entry.created_at)));
      card.append(header, block('p', entry.body));
      return card;
    });
    if (append) thread.prepend(...cards);
    else { thread.append(...cards); container.append(thread); }
  }

  async function openThread(id, before) {
    const data = await api(route('/' + id + (before ? '?before=' + before : '')));
    current = data.ticket;
    ticketId = id;
    view = 'thread';
    if (before) {
      container.querySelector('.ticket-older')?.remove();
      renderMessages(data.messages, true);
    } else {
      toolbar('#' + number.format(current.id) + ' · ' + current.subject, [button('بازگشت به تیکت‌ها', () => list())]);
      container.append(block('p', current.department + ' · ' + statuses[current.status] +
        (staff ? ' · مشتری ' + current.customer : ''), 'ticket-meta'));
      renderMessages(data.messages, false);
      renderThreadActions();
    }
    if (data.next) {
      const more = button('پیام‌های قدیمی‌تر', () => openThread(id, data.next));
      more.classList.add('ticket-older');
      container.querySelector('.ticket-thread').before(more);
    }
  }

  function renderThreadActions() {
    const isFinished = finished.has(current.status);
    const version = current.version;
    const id = current.id;
    if (staff) {
      const status = select(Object.entries(statuses), current.status);
      const priority = select(Object.entries(priorities), current.priority);
      const department = select(options.departments.filter(unit => unit.active || unit.id === current.department_id).map(unit => [unit.id, unit.name]), current.department_id);
      const operators = options.staff.map(operator => [operator.id, operator.name + ' (@' + operator.username + ')']);
      if (current.assignee_id && !operators.some(([key]) => key === current.assignee_id)) {
        operators.push([current.assignee_id, current.assignee + ' (دسترسی مدیریتی پایان یافته)']);
      }
      const assignee = select([['', 'بدون ارجاع'], ...operators], current.assignee_id ?? '');
      const controls = form(field('وضعیت', status), field('اولویت', priority), field('دپارتمان', department),
        field('مسئول رسیدگی', assignee), submit('ذخیرهٔ تغییرات تیکت'));
      controls.classList.add('ticket-filters');
      onSubmit(controls, async () => {
        await api(route('/' + id + '/update'), { version, status: status.value, department: Number(department.value),
          priority: priority.value, assignee: assignee.value ? Number(assignee.value) : null });
        await openThread(id);
        return 'تغییرات تیکت ذخیره شد.';
      });
      container.append(controls);
    } else {
      const nextStatus = isFinished ? 'open' : 'closed';
      container.append(button(isFinished ? 'بازگشایی تیکت' : 'بستن تیکت', async () => {
        await api(route('/' + id + '/update'), { version, status: nextStatus });
        await openThread(id);
      }));
    }
    if (isFinished && !staff) return;
    const reply = input('', 4000, true);
    reply.required = true;
    const mode = select(isFinished ? [['note', 'یادداشت داخلی']] : [['reply', 'پاسخ به مشتری'], ['note', 'یادداشت داخلی']]);
    const editor = form(...(staff ? [field('نوع پیام', mode)] : []), field('متن پیام', reply), submit('ارسال'));
    onSubmit(editor, async () => {
      await api(route('/' + id + '/reply'), { message: reply.value, internal: staff && mode.value === 'note', version });
      await openThread(id);
      return 'پیام ثبت شد.';
    });
    container.append(editor);
  }

  async function departmentList() {
    await loadOptions();
    view = 'departments';
    toolbar('مدیریت دپارتمان‌ها', [
      button('افزودن دپارتمان', () => departmentEditor(null), true), button('بازگشت به تیکت‌ها', () => list()),
    ]);
    const units = block('ul', '', 'ticket-list');
    for (const department of options.departments) {
      const item = block('li');
      item.append(button(department.name, () => departmentEditor(department)),
        block('span', department.active ? 'فعال' : 'غیرفعال', 'ticket-pill'),
        block('p', department.description, 'ticket-meta'));
      units.append(item);
    }
    container.append(units);
  }

  function departmentEditor(department) {
    toolbar(department ? 'ویرایش دپارتمان' : 'افزودن دپارتمان', [button('بازگشت به دپارتمان‌ها', departmentList)]);
    const name = input(department?.name || '', 60);
    name.required = true;
    const description = input(department?.description || '', 240, true);
    const availability = select([['1', 'فعال برای تیکت جدید'], ['0', 'غیرفعال']], department?.active ?? 1);
    const editor = form(field('نام دپارتمان', name), field('توضیحات', description), field('دسترسی', availability), submit('ذخیرهٔ دپارتمان'));
    onSubmit(editor, async () => {
      await api(route('/departments'), { id: department?.id ?? null, name: name.value, description: description.value, active: availability.value === '1' });
      await departmentList();
      return 'دپارتمان ذخیره شد.';
    });
    container.append(editor);
  }

  return {
    get visible() { return !container.hidden; },
    close() {
      container.hidden = true;
      container.replaceChildren();
    },
    async open(admin, id) {
      staff = admin;
      filters = staff ? { status: 'active' } : {};
      await loadOptions();
      if (id) await openThread(id);
      else await list();
      container.hidden = false;
      container.focus();
    },
    async refresh() {
      await loadOptions();
      if (view === 'thread') await openThread(ticketId);
      else if (view === 'departments') await departmentList();
      else if (view === 'create') createView();
      else await list();
    },
  };
}
