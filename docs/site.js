'use strict';

const demoButtons = [...document.querySelectorAll('.demo-switch button')];

for (const button of demoButtons) {
  button.addEventListener('click', () => {
    for (const option of demoButtons) {
      const selected = option === button;
      option.setAttribute('aria-pressed', String(selected));
      document.getElementById(option.getAttribute('aria-controls')).hidden = !selected;
    }
  });
}

// The project site's owner and repository come from its default GitHub Pages URL.
const pagesHost = location.hostname.match(/^([a-z0-9-]+)\.github\.io$/i);
const repositoryName = location.pathname.split('/')[1];

if (pagesHost && /^[a-z0-9_.-]+$/i.test(repositoryName)) {
  const repositoryUrl = `https://github.com/${pagesHost[1]}/${repositoryName}`;

  for (const link of document.querySelectorAll('[data-repo-path]')) {
    link.href = repositoryUrl + link.dataset.repoPath;
  }
}
