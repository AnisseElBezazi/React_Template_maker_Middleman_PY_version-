const dz = document.getElementById('dropzone');
      const input = document.getElementById('fileInput');
      const form = document.getElementById('uploadForm');
      const submitBtn = document.getElementById('submitBtn');
      const submitLabel = submitBtn.querySelector('.btn-label');

      function setPdf(file) {
        if (!file) return;
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        dz.classList.add('has-file');
        dz.querySelector('.big').textContent = file.name;
        dz.querySelector('.sub').textContent = (file.size / 1024 / 1024).toFixed(2) + ' Mo — prêt';
        submitBtn.disabled = false;
        submitLabel.textContent = 'Lancer la génération';
      }
      dz.addEventListener('click', () => input.click());
      dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
      dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
      dz.addEventListener('drop', (e) => {
        e.preventDefault(); dz.classList.remove('drag');
        if (e.dataTransfer.files.length) setPdf(e.dataTransfer.files[0]);
      });
      input.addEventListener('change', () => { if (input.files.length) setPdf(input.files[0]); });

      // Onglets fichier / coller pour l'extra_config
      const tabBtns = document.querySelectorAll('.tab-btn');
      const panels = document.querySelectorAll('.tab-panel');
      tabBtns.forEach((btn) => btn.addEventListener('click', () => {
        tabBtns.forEach((b) => b.classList.remove('active'));
        panels.forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        document.querySelector('.tab-panel[data-panel="' + btn.dataset.tab + '"]').classList.add('active');
      }));

      // extra_config par fichier
      const ecDrop = document.getElementById('extraConfigDrop');
      const ecInput = document.getElementById('extraConfigInput');
      const ecLabel = document.getElementById('extraConfigDropLabel');
      function setExtraConfigFile(file) {
        if (!file) return;
        const dt = new DataTransfer();
        dt.items.add(file);
        ecInput.files = dt.files;
        ecDrop.classList.add('has-file');
        ecLabel.textContent = file.name;
      }
      ecDrop.addEventListener('click', () => ecInput.click());
      ecDrop.addEventListener('dragover', (e) => { e.preventDefault(); ecDrop.classList.add('drag'); });
      ecDrop.addEventListener('dragleave', () => ecDrop.classList.remove('drag'));
      ecDrop.addEventListener('drop', (e) => {
        e.preventDefault(); ecDrop.classList.remove('drag');
        if (e.dataTransfer.files.length) setExtraConfigFile(e.dataTransfer.files[0]);
      });
      ecInput.addEventListener('change', () => { if (ecInput.files.length) setExtraConfigFile(ecInput.files[0]); });

      // extra_config collé en texte -- validation JSON en direct + recopie dans le champ caché envoyé au serveur
      const ecText = document.getElementById('extraConfigText');
      const ecTextHidden = document.getElementById('extraConfigTextHidden');
      const ecStatus = document.getElementById('extraConfigStatus');
      ecText.addEventListener('input', () => {
        const val = ecText.value.trim();
        ecTextHidden.value = val;
        if (!val) { ecStatus.textContent = ''; ecStatus.className = ''; return; }
        try {
          JSON.parse(val);
          ecStatus.textContent = 'JSON valide';
          ecStatus.className = 'ok';
        } catch (e) {
          ecStatus.textContent = 'JSON invalide : ' + e.message;
          ecStatus.className = 'err';
        }
      });

      form.addEventListener('submit', (e) => {
        if (ecText.value.trim()) {
          try { JSON.parse(ecText.value.trim()); }
          catch {
            e.preventDefault();
            ecStatus.textContent = 'Corrige le JSON avant de lancer.';
            ecStatus.className = 'err';
            document.querySelector('.tab-btn[data-tab="paste"]').click();
            ecText.focus();
            return;
          }
        }
        submitBtn.disabled = true;
        submitLabel.textContent = 'Démarrage...';
      });
