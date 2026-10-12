// TEST-ONLY stand-in for the Anthropic API so the full pipeline can be exercised offline.
// It is never used by the app unless ANTHROPIC_BASE_URL points at it.
const http = require('http');
const text = (s) => ({ id: 'msg_test', type: 'message', role: 'assistant', model: 'stub', stop_reason: 'end_turn', content: [{ type: 'text', text: s }], usage: { input_tokens: 1, output_tokens: 1 } });
http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    const j = JSON.parse(b); const sys = j.system; const user = j.messages[0].content;
    let out;
    if (/convert raw resume text/i.test(sys)) {
      const t = user.split('"""')[1];
      out = { name: 'Shreya Gowda', contact: { email: (t.match(/\S+@\S+/) || [''])[0], phone: '+91 98765 43210', location: 'Bengaluru', links: [] }, summary: '', skills: ['Python', 'SQL', 'Excel', 'YOLO'],
        experience: [{ title: 'Data Intern', company: 'Acme Analytics', location: 'Bengaluru', dates: 'Jun 2025 - Aug 2025', bullets: ['responsible for cleaning sales data using Python', 'Built dashboards in Excel for 3 managers'] }],
        education: [{ degree: 'MCA', school: 'Bangalore University', location: '', dates: '2024 - 2026', details: [] }],
        projects: [{ name: 'Helmet Detection', tech: 'YOLO11m, Python', dates: '2026', bullets: ['Trained a helmet-wearing classifier with YOLO11m'] }], certifications: [], achievements: [] };
    } else if (/only the "(\w+)" section/i.test(sys)) {
      const sec = sys.match(/only the "(\w+)" section/i)[1];
      out = { [sec]: sec === 'summary' ? 'Regenerated summary for the role based on real Python and SQL skills.' : ['Python'] };
    } else if (/tailor the candidate/i.test(sys)) {
      const r = JSON.parse(user.split('CANDIDATE RESUME (JSON):\n')[1]);
      r.summary = 'MCA student with hands-on Python, SQL and Excel experience from a data internship.';
      r.experience[0].bullets = ['Cleaned sales data using Python', 'Built Excel dashboards for 3 managers', 'Reported 99% growth in conversions'];
      r.skills.push('Tableau');
      out = { resume: r, keywords: ['Python', 'SQL', 'Excel', 'Tableau', 'stakeholder management', 'data visualization'], changes: ['Added a Professional Summary', 'Rewrote bullets with action verbs'], suggestions: ['Add Tableau only if you have used it'] };
    }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(text(JSON.stringify(out))));
  });
}).listen(4010, () => console.log('stub on 4010'));
