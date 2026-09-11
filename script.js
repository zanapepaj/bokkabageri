/* =========================================================
   Bokka Bageri — script.js
   Vanilla JS only. Handles:
   - interest form validation
   - asynchronous submission to Formspree (no page reload)
   - a warm success message
   - gentle scroll-reveal animations
   ========================================================= */

(function () {
  "use strict";

  /* -----------------------------------------------------
     Interest form
     ----------------------------------------------------- */
  const form = document.getElementById("interest-form");
  const successBox = document.getElementById("form-success");
  const successText = document.getElementById("form-success-text");
  const resetBtn = document.getElementById("form-reset");
  const submitBtn = form ? form.querySelector('button[type="submit"]') : null;
  const formError = document.getElementById("form-error");
  const submitBtnLabel = submitBtn ? submitBtn.textContent : "";

  /**
   * Very light contact check: accept either an email-ish string
   * or a phone number with at least 8 digits. We stay forgiving
   * on purpose — this is a low-pressure interest form.
   */
  function isValidContact(value) {
    const trimmed = value.trim();
    const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
    const digitCount = (trimmed.match(/\d/g) || []).length;
    const looksLikePhone = digitCount >= 8;
    return looksLikeEmail || looksLikePhone;
  }

  function setError(input, errorEl, show) {
    if (show) {
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-describedby", errorEl.id);
      errorEl.hidden = false;
    } else {
      input.removeAttribute("aria-invalid");
      input.removeAttribute("aria-describedby");
      errorEl.hidden = true;
    }
  }

  if (form) {
    const firstName = form.elements["fornavn"];
    const contact = form.elements["kontakt"];
    const firstNameError = document.getElementById("fornavn-error");
    const contactError = document.getElementById("kontakt-error");

    // Clear an error as soon as the neighbour starts fixing it.
    firstName.addEventListener("input", function () {
      if (firstName.value.trim()) setError(firstName, firstNameError, false);
    });
    contact.addEventListener("input", function () {
      if (isValidContact(contact.value)) setError(contact, contactError, false);
    });

    form.addEventListener("submit", function (event) {
      event.preventDefault();

      const nameOk = firstName.value.trim().length > 0;
      const contactOk = isValidContact(contact.value);

      setError(firstName, firstNameError, !nameOk);
      setError(contact, contactError, !contactOk);

      if (!nameOk) {
        firstName.focus();
        return;
      }
      if (!contactOk) {
        contact.focus();
        return;
      }

      submitToFormspree();
    });

    if (resetBtn) {
      resetBtn.addEventListener("click", function () {
        form.reset();
        hideFormError();
        setSubmitting(false);
        successBox.hidden = true;
        form.hidden = false;
        firstName.focus();
      });
    }
  }

  /**
   * Send the form to Formspree with fetch so the page never reloads.
   * The success state is shown only after Formspree confirms (HTTP 2xx);
   * a network error or non-OK response shows a friendly notice instead.
   */
  function submitToFormspree() {
    if (!form) return;
    hideFormError();
    setSubmitting(true);

    const name = form.elements["fornavn"].value.trim();

    fetch(form.action, {
      method: "POST",
      body: new FormData(form),
      headers: { Accept: "application/json" },
    })
      .then(function (response) {
        if (response.ok) {
          showSuccess(name);
        } else {
          showFormError();
        }
      })
      .catch(function () {
        showFormError();
      })
      .then(function () {
        setSubmitting(false);
      });
  }

  function setSubmitting(isSubmitting) {
    if (!submitBtn) return;
    submitBtn.disabled = isSubmitting;
    if (isSubmitting) {
      form.setAttribute("aria-busy", "true");
      submitBtn.textContent = "Sender …";
    } else {
      form.removeAttribute("aria-busy");
      submitBtn.textContent = submitBtnLabel;
    }
  }

  function showFormError() {
    if (formError) formError.hidden = false;
  }

  function hideFormError() {
    if (formError) formError.hidden = true;
  }

  function showSuccess(name) {
    if (!successBox) return;
    if (successText) {
      successText.textContent =
        "Takk, " +
        name +
        "! Vi sier fra neste gang Bokka fyrer opp ovnen. Helt uforpliktende, som lovet.";
    }
    form.hidden = true;
    successBox.hidden = false;
    // Move focus so screen readers announce the result.
    successBox.setAttribute("tabindex", "-1");
    successBox.focus();
    successBox.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  /* -----------------------------------------------------
     Weekend order form ("Denne helgen baker vi")
     Separate from the interest form: its own Formspree
     submission, quantity steppers, success and error states.
     ----------------------------------------------------- */
  (function initOrderForm() {
    const orderForm = document.getElementById("order-form");
    if (!orderForm) return;

    const orderSuccess = document.getElementById("order-success");
    const orderSuccessText = document.getElementById("order-success-text");
    const orderError = document.getElementById("order-error");
    const orderEmpty = document.getElementById("order-empty");
    const orderReset = document.getElementById("order-reset");
    const orderSubmit = orderForm.querySelector('button[type="submit"]');
    const orderSubmitLabel = orderSubmit ? orderSubmit.textContent : "";
    const summaryField = orderForm.elements["Bestilling"];

    const firstName = orderForm.elements["fornavn"];
    const mobile = orderForm.elements["mobil"];
    const address = orderForm.elements["adresse"];
    const firstNameError = document.getElementById("order-fornavn-error");
    const mobileError = document.getElementById("order-mobil-error");
    const addressError = document.getElementById("order-adresse-error");

    const qtyInputs = Array.prototype.slice.call(
      orderForm.querySelectorAll(".qty__input")
    );

    function clampQty(value) {
      const n = parseInt(value, 10);
      if (isNaN(n)) return 0;
      return Math.max(0, Math.min(10, n));
    }

    function hasItems() {
      return qtyInputs.some(function (input) {
        return clampQty(input.value) > 0;
      });
    }

    function isValidPhone(value) {
      return (value.match(/\d/g) || []).length >= 8;
    }

    // Wire up the +/- steppers, keeping every value inside 0–10.
    Array.prototype.forEach.call(
      orderForm.querySelectorAll("[data-qty]"),
      function (wrap) {
        const input = wrap.querySelector(".qty__input");
        const dec = wrap.querySelector("[data-qty-dec]");
        const inc = wrap.querySelector("[data-qty-inc]");
        if (!input) return;

        function set(next) {
          input.value = clampQty(next);
          if (orderEmpty && hasItems()) orderEmpty.hidden = true;
        }
        if (dec) dec.addEventListener("click", function () { set(clampQty(input.value) - 1); });
        if (inc) inc.addEventListener("click", function () { set(clampQty(input.value) + 1); });
        input.addEventListener("change", function () { set(input.value); });
      }
    );

    // Clear field errors as the visitor fixes them.
    firstName.addEventListener("input", function () {
      if (firstName.value.trim()) setError(firstName, firstNameError, false);
    });
    mobile.addEventListener("input", function () {
      if (isValidPhone(mobile.value)) setError(mobile, mobileError, false);
    });
    address.addEventListener("input", function () {
      if (address.value.trim()) setError(address, addressError, false);
    });

    orderForm.addEventListener("submit", function (event) {
      event.preventDefault();

      const nameOk = firstName.value.trim().length > 0;
      const phoneOk = isValidPhone(mobile.value);
      const addressOk = address.value.trim().length > 0;
      const itemsOk = hasItems();

      setError(firstName, firstNameError, !nameOk);
      setError(mobile, mobileError, !phoneOk);
      setError(address, addressError, !addressOk);
      if (orderEmpty) orderEmpty.hidden = itemsOk;

      if (!itemsOk) {
        if (orderEmpty) orderEmpty.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      if (!nameOk) { firstName.focus(); return; }
      if (!phoneOk) { mobile.focus(); return; }
      if (!addressOk) { address.focus(); return; }

      submitOrder();
    });

    if (orderReset) {
      orderReset.addEventListener("click", function () {
        orderForm.reset();
        qtyInputs.forEach(function (input) { input.value = 0; });
        if (orderError) orderError.hidden = true;
        if (orderEmpty) orderEmpty.hidden = true;
        setOrderSubmitting(false);
        if (orderSuccess) orderSuccess.hidden = true;
        orderForm.hidden = false;
        firstName.focus();
      });
    }

    // Build a readable "Kanelbolle × 2, Solbolle × 1" line for the email.
    function buildSummary() {
      return qtyInputs
        .map(function (input) {
          const n = clampQty(input.value);
          if (n <= 0) return null;
          const name = input.getAttribute("data-product") || input.name;
          return name + " \u00d7 " + n;
        })
        .filter(Boolean)
        .join(", ");
    }

    function submitOrder() {
      if (orderError) orderError.hidden = true;
      if (summaryField) summaryField.value = buildSummary();
      setOrderSubmitting(true);

      const name = firstName.value.trim();

      fetch(orderForm.action, {
        method: "POST",
        body: new FormData(orderForm),
        headers: { Accept: "application/json" },
      })
        .then(function (response) {
          if (response.ok) {
            showOrderSuccess(name);
          } else if (orderError) {
            orderError.hidden = false;
          }
        })
        .catch(function () {
          if (orderError) orderError.hidden = false;
        })
        .then(function () {
          setOrderSubmitting(false);
        });
    }

    function setOrderSubmitting(isSubmitting) {
      if (!orderSubmit) return;
      orderSubmit.disabled = isSubmitting;
      if (isSubmitting) {
        orderForm.setAttribute("aria-busy", "true");
        orderSubmit.textContent = "Sender \u2026";
      } else {
        orderForm.removeAttribute("aria-busy");
        orderSubmit.textContent = orderSubmitLabel;
      }
    }

    function showOrderSuccess(name) {
      if (!orderSuccess) return;
      if (orderSuccessText) {
        orderSuccessText.textContent =
          "Takk for bestillingen, " + name +
          "! Vi har notert ønsket ditt for helgen. Bokka gir deg beskjed så snart vi kan – bestillingen er først bekreftet når du får svar fra oss. 🌾";
      }
      orderForm.hidden = true;
      orderSuccess.hidden = false;
      orderSuccess.setAttribute("tabindex", "-1");
      orderSuccess.focus();
      orderSuccess.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  })();

  /* -----------------------------------------------------
     Gentle scroll-reveal animations
     Respects prefers-reduced-motion via CSS.
     ----------------------------------------------------- */
  const revealTargets = document.querySelectorAll(
    ".product-card, .order-card, .step, .bobler-card, .bobler__art, .story__inner, .section__head, .interest__card"
  );

  const prefersReducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches;

  if ("IntersectionObserver" in window && !prefersReducedMotion) {
    revealTargets.forEach(function (el) {
      el.classList.add("reveal");
    });

    const observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12 }
    );

    revealTargets.forEach(function (el) {
      observer.observe(el);
    });
  }
})();
