import {
  Fragment,
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { readFunctionalStorage, writeFunctionalStorage } from "@meltiply/ui/cookie-consent";

import { isDevMode } from "@/lib/env";

import { isPseudoLocalized, pseudoLocaleEvent, pseudoLocalize } from "./pseudo-locale";

export const supportedLanguages = [
  { code: "en", label: "English" },
  { code: "es", label: "Español" },
] as const;

export type Language = (typeof supportedLanguages)[number]["code"];
export type TranslationValues = Record<string, number | string>;

const languageStorageKey = "meltiply.language";

const spanishTranslations: Record<string, string> = {
  Created: "Creado",
  Caption: "Texto de la publicación",
  "Calendar period": "Período del calendario",
  "Previous week": "Semana anterior",
  "Next week": "Semana siguiente",
  "View posts on {date}": "Ver publicaciones del {date}",
  "Schedule post on {date}": "Programar publicación para el {date}",
  "Schedule Post": "Programar publicación",
  "Date & time": "Fecha y hora",
  Date: "Fecha",
  "Choose date": "Elegir fecha",
  Time: "Hora",
  "Choose time": "Elegir hora",
  "Time (24-hour)": "Hora (24 horas)",
  Hour: "Hora",
  Minute: "Minuto",
  Done: "Listo",
  "Time zone: {zone}": "Zona horaria: {zone}",
  "+{count} more": "+{count} más",
  "No posts": "Sin publicaciones",
  "New Post": "Nueva publicación",
  System: "Sistema",
  "Filter by": "Filtrar por",
  "No filters applied. Add a filter to narrow this collection.":
    "No hay filtros aplicados. Añade un filtro para acotar esta colección.",
  Where: "Donde",
  and: "y",
  is: "es",
  "Remove {label} filter": "Quitar filtro {label}",
  "Remove filter": "Quitar filtro",
  "Add filter:": "Añadir filtro:",
  "Add {label} filter": "Añadir filtro {label}",
  "Connected accounts": "Cuentas conectadas",
  "{count} connected accounts across {profiles} Brand Profiles.":
    "{count} cuentas conectadas en {profiles} perfiles de marca.",
  "Channel directory sections": "Secciones del directorio de canales",
  Accounts: "Cuentas",
  "{count} accounts": "{count} cuentas",
  "No Brand Profiles yet. Ask a workspace admin to create one, or use Create Brand Profile if you are an admin.":
    "Aún no hay perfiles de marca. Pide a un administrador que cree uno o usa Crear perfil de marca si eres administrador.",
  "Edit {name}": "Editar {name}",
  "Publishing identity and connected accounts.": "Identidad de publicación y cuentas conectadas.",
  "{count} connected accounts": "{count} cuentas conectadas",
  "View channels": "Ver canales",
  "Could not sign out": "No se pudo cerrar la sesión",
  "Try again to end your session.": "Inténtalo de nuevo para cerrar la sesión.",
  "Workspace navigation": "Navegación del espacio de trabajo",
  "Collapse sidebar": "Contraer barra lateral",
  "Expand sidebar": "Expandir barra lateral",
  "Search and jump to": "Buscar e ir a",
  "Help and resources": "Ayuda y recursos",
  Creator: "Creador",
  "Account menu": "Menú de la cuenta",
  "Account settings": "Configuración de la cuenta",
  "Post actions": "Acciones de publicación",
  "Showing {count} posts across your Brand Profiles.":
    "Mostrando {count} publicaciones de tus perfiles de marca.",
  "Posts table": "Tabla de publicaciones",
  Channels: "Canales",
  "Publish date": "Fecha de publicación",
  "All posts": "Todas las publicaciones",
  "Toggle {label} group": "Expandir o contraer el grupo {label}",
  "Sort:": "Ordenar:",
  Newest: "Más recientes",
  Oldest: "Más antiguas",
  "Group:": "Agrupar:",
  None: "Ninguno",
  Columns: "Columnas",
  "Post view": "Vista de publicaciones",
  Table: "Tabla",
  "Skip to content": "Saltar al contenido",
  "Search or jump to…": "Buscar o ir a…",
  Filter: "Filtrar",
  Filters: "Filtros",
  "Clear {label} filter": "Quitar filtro {label}",
  "Reset filters": "Restablecer filtros",
  "Clear all": "Limpiar todo",
  Appearance: "Apariencia",
  "Choose the palette for this device.": "Elige la paleta para este dispositivo.",
  "Choose the language used throughout your workspace.":
    "Elige el idioma de tu espacio de trabajo.",
  "Account and workspace": "Cuenta y espacio de trabajo",
  "Your installation identity. These details are read-only.":
    "Tu identidad en esta instalación. Estos datos son de solo lectura.",
  Security: "Seguridad",
  "Change your password, set up an authenticator, or replace recovery codes. Security changes require your current password.":
    "Cambia tu contraseña, configura un autenticador o reemplaza los códigos de recuperación. Los cambios de seguridad requieren tu contraseña actual.",
  "Settings sections": "Secciones de configuración",
  "Theme changes apply immediately. Saving your preference across visits requires functional cookie consent.":
    "El tema cambia de inmediato. Para recordar tu preferencia entre visitas debes aceptar las cookies funcionales.",
  "Interface language": "Idioma de la interfaz",
  "Language changes apply immediately. Saving your preference across visits requires functional cookie consent.":
    "El idioma cambia de inmediato. Para recordar tu preferencia entre visitas debes aceptar las cookies funcionales.",
  "Find workspace pages and Brand Profiles. Search posts and channels from their page toolbar.":
    "Busca páginas y perfiles de marca. Busca publicaciones y canales desde la barra de su página.",
  "Search pages and Brand Profiles": "Buscar páginas y perfiles de marca",
  "Search pages and Brand Profiles…": "Buscar páginas y perfiles de marca…",
  "No matching pages or Brand Profiles.": "No hay páginas ni perfiles de marca que coincidan.",
  "Tab to move · Enter to open · Esc to close":
    "Tab para moverte · Intro para abrir · Esc para cerrar",
  "Selection actions": "Acciones de selección",
  "{count} selected": "{count} seleccionados",
  Deselect: "Deseleccionar",
  "Select all visible channels": "Seleccionar todos los canales visibles",
  "Select channel": "Seleccionar canal",
  "Channels could not be disconnected": "No se pudieron desconectar los canales",
  "Disconnect {count} channels?": "¿Desconectar {count} canales?",
  "Scheduled and queued posts for these channels will stop publishing. You can reconnect them at any time.":
    "Las publicaciones programadas y en cola para estos canales dejarán de publicarse. Puedes volver a conectarlos en cualquier momento.",
  "{count} channels disconnected": "{count} canales desconectados",
  "{succeeded} of {total} channels disconnected": "{succeeded} de {total} canales desconectados",
  "{failed} could not be disconnected and remain selected.":
    "No se pudieron desconectar {failed} y siguen seleccionados.",
  "Select post": "Seleccionar publicación",
  "Select all visible posts": "Seleccionar todas las publicaciones visibles",
  "Select all posts for this day": "Seleccionar todas las publicaciones de este día",
  "Select all posts": "Seleccionar todas las publicaciones",
  "Delete {count} posts?": "¿Eliminar {count} publicaciones?",
  "Deleting the selected posts removes their drafts and stops their pending channels. Anything already published stays live on its platform — deleting a post here never removes a copy from a platform.":
    "Eliminar las publicaciones seleccionadas elimina sus borradores y detiene sus canales pendientes. Lo ya publicado permanece en su plataforma: eliminar aquí nunca elimina una copia de la plataforma.",
  "Keep posts": "Conservar publicaciones",
  "Deleted {count} posts": "Se eliminaron {count} publicaciones",
  "The posts were removed and their pending channels stopped.":
    "Se eliminaron las publicaciones y se detuvieron sus canales pendientes.",
  "Could not delete the selected posts": "No se pudieron eliminar las publicaciones seleccionadas",
  "Deleted {succeeded} of {total} posts": "Se eliminaron {succeeded} de {total} publicaciones",
  "{failed} could not be deleted and remain selected.":
    "No se pudieron eliminar {failed} y siguen seleccionadas.",
  "Channel settings": "Configuración del canal",
  "Copy username": "Copiar nombre de usuario",
  "Copy channel ID": "Copiar ID del canal",
  "Username: {username}": "Nombre de usuario: {username}",
  "Username not provided": "Nombre de usuario no proporcionado",
  Likes: "Me gusta",
  Cmts: "Com.",
  Shrs: "Comp.",
  Shares: "Compartidos",
  Saves: "Guardados",
  Clicks: "Clics",
  Views: "Visualizaciones",
  "Impr.": "Impr.",
  Impressions: "Impresiones",
  Reach: "Alcance",
  "Username copied": "Nombre de usuario copiado",
  "Channel ID copied": "ID del canal copiado",
  "Copied “{value}” to your clipboard.": "Se copió «{value}» al portapapeles.",
  "Could not copy": "No se pudo copiar",
  "Select the value and copy it manually.": "Selecciona el valor y cópialo manualmente.",
  "The selected Page is ready to publish to.": "La página seleccionada está lista para publicar.",
  "The post and its pending channels were removed.":
    "Se eliminaron la publicación y sus canales pendientes.",
  "Cancelled {count} pending channel(s).": "Se cancelaron {count} canal(es) pendiente(s).",
  "{channel} scheduled for {date}": "{channel} programado para {date}",
  "Previous month": "Mes anterior",
  "Next month": "Mes siguiente",
  "Sort by date": "Ordenar por fecha",
  "has no channels yet": "aún no tiene canales",
  "Optional context for this profile": "Contexto opcional para este perfil",
  "Name, describe, and color-label the ownership scope for channels, assets, and posts.":
    "Nombra, describe y etiqueta con color el ámbito de propiedad de canales, recursos y publicaciones.",
  "Profile description": "Descripción del perfil",
  "No profile description": "Sin descripción del perfil",
  "Authentication failed. Please try again.":
    "La autenticación falló. Por favor, inténtalo de nuevo.",
  "Email address": "Correo electrónico",
  Password: "Contraseña",
  "Your name": "Tu nombre",
  "Make this workspace yours.": "Haz tuyo este espacio de trabajo.",
  "Email verified. Sign in to continue.": "Correo verificado. Inicia sesión para continuar.",
  "Welcome back.": "Te damos la bienvenida de nuevo.",
  "Recover your access.": "Recupera tu acceso.",
  "Choose a new password.": "Elige una contraseña nueva.",
  "One more security check.": "Una comprobación de seguridad más.",
  "One place to shape what’s next.": "Un lugar para crear lo que viene.",
  "Compose your posts, connect your channels, and publish on your terms.":
    "Crea tus publicaciones, conecta tus canales y publica a tu manera.",
  "Self-hosted. Single owner. Your account is the only way into this installation.":
    "Alojamiento propio. Un único propietario. Tu cuenta es la única forma de acceder a esta instalación.",
  "Create the only account for this installation. You’ll need the setup secret from your deployment configuration.":
    "Crea la única cuenta de esta instalación. Necesitarás el secreto de configuración de tu despliegue.",
  "Enter a code from your authenticator, or use a saved backup code.":
    "Introduce un código de tu autenticador o un código de recuperación guardado.",
  "We’ll send a reset link to the owner’s email address.":
    "Enviaremos un enlace de restablecimiento al correo del propietario.",
  "Use a unique password or a long passphrase. All previous sessions will be signed out.":
    "Usa una contraseña única o una frase larga. Se cerrarán todas las sesiones anteriores.",
  "Sign in with the owner account to continue to your workspace.":
    "Inicia sesión con la cuenta del propietario para acceder a tu espacio de trabajo.",
  "Checking installation…": "Comprobando la instalación…",
  "Could not check installation status.": "No se pudo comprobar el estado de la instalación.",
  "This link is invalid or expired. Request a new verification or password reset link.":
    "Este enlace no es válido o ha caducado. Solicita otro enlace de verificación o de restablecimiento.",
  "Owner account created. Check your email to verify your address, then sign in.":
    "Cuenta del propietario creada. Verifica tu dirección desde el correo recibido e inicia sesión.",
  "This installation now has an owner. Sign in, or resend verification if this is your account.":
    "Esta instalación ya tiene propietario. Inicia sesión o reenvía la verificación si es tu cuenta.",
  "If this address belongs to the owner, a password reset link will arrive by email.":
    "Si esta dirección pertenece al propietario, recibirá un enlace de restablecimiento por correo.",
  "Password updated. Sign in again with your new password.":
    "Contraseña actualizada. Inicia sesión con tu nueva contraseña.",
  "Enter your email address first.": "Introduce primero tu dirección de correo.",
  "If verification is needed, a new link will arrive by email.":
    "Si se necesita verificación, recibirás un enlace nuevo por correo.",
  "Could not send a verification link.": "No se pudo enviar el enlace de verificación.",
  "8–128 characters. Passphrases and password managers welcome.":
    "Entre 8 y 128 caracteres. Puedes usar frases de contraseña y gestores de contraseñas.",
  "Setup secret": "Secreto de configuración",
  "Use AUTH_SETUP_SECRET from your private deployment environment. It is not your account password.":
    "Usa AUTH_SETUP_SECRET de tu entorno privado de despliegue. No es la contraseña de tu cuenta.",
  "Backup code": "Código de recuperación",
  "Authenticator code": "Código del autenticador",
  "Please wait…": "Espera…",
  "Create owner account": "Crear cuenta del propietario",
  "Send reset link": "Enviar enlace de restablecimiento",
  "Update password": "Actualizar contraseña",
  "Verify and sign in": "Verificar e iniciar sesión",
  "Forgot password?": "¿Olvidaste tu contraseña?",
  "Resend verification": "Reenviar verificación",
  "Use authenticator instead": "Usar el autenticador",
  "Use a backup code": "Usar un código de recuperación",
  "Back to sign in": "Volver al inicio de sesión",
  "Account security": "Seguridad de la cuenta",
  "Protect the only account for this installation. Changes to your password or authenticator sign out previous sessions.":
    "Protege la única cuenta de esta instalación. Los cambios de contraseña o autenticador cierran las sesiones anteriores.",
  "Current password": "Contraseña actual",
  "New password": "Contraseña nueva",
  "Enter your current password to continue.": "Introduce tu contraseña actual para continuar.",
  "Could not update account security.": "No se pudo actualizar la seguridad de la cuenta.",
  "Finish or cancel the current security action before leaving this section.":
    "Completa o cancela la acción de seguridad actual antes de salir de esta sección.",
  "Authenticator setup key": "Clave de configuración del autenticador",
  "Add a time-based account named Meltiply in your authenticator using this key. Keep it secret.":
    "Añade una cuenta basada en tiempo llamada Meltiply en tu autenticador con esta clave. Mantenla en secreto.",
  "Save your backup codes": "Guarda tus códigos de recuperación",
  "Store these somewhere safe before continuing. Each code works once. New codes invalidate the previous set.":
    "Guárdalos en un lugar seguro antes de continuar. Cada código funciona una vez. Los nuevos códigos invalidan los anteriores.",
  "I saved my codes — verify": "He guardado mis códigos: verificar",
  "Cancel enrollment": "Cancelar configuración",
  "I saved my codes": "He guardado mis códigos",
  "Could not confirm server sign-out. Sign in again to check your sessions.":
    "No se pudo confirmar el cierre de sesión en el servidor. Inicia sesión para comprobar tus sesiones.",
  "Two-factor authentication": "Autenticación en dos pasos",
  "An authenticator code is required at sign-in. Use a backup code if you lose your authenticator.":
    "Se requiere un código al iniciar sesión. Usa un código de recuperación si pierdes tu autenticador.",
  "Add an authenticator app and save recovery codes before enabling this extra sign-in check.":
    "Añade una aplicación de autenticación y guarda los códigos de recuperación antes de activar esta comprobación.",
  "Replace backup codes": "Reemplazar códigos de recuperación",
  "Disable two-factor": "Desactivar autenticación en dos pasos",
  "Set up authenticator": "Configurar autenticador",
  "Change password and sign out": "Cambiar contraseña y cerrar sesión",
  Account: "Cuenta",
  "All platforms": "Todas las plataformas",
  Analytics: "Analíticas",
  Calendar: "Calendario",
  Cancel: "Cancelar",
  "Choose an active workspace to continue.": "Elige un espacio de trabajo activo para continuar.",
  "Choose an organization": "Elige una organización",
  Close: "Cerrar",
  Breadcrumb: "Ruta de navegación",
  Comments: "Comentarios",
  Connect: "Conectar",
  Connected: "Conectadas",
  Details: "Detalles",
  Dashboard: "Panel",
  Delete: "Eliminar",
  Dark: "Oscuro",
  "Deleting…": "Eliminando…",
  Disconnect: "Desconectar",
  Duet: "Duet",
  Email: "Correo electrónico",
  English: "English",
  Español: "Español",
  Everyone: "Todos",
  Expired: "Caducada",
  "Expires {date}": "Caduca el {date}",
  Followers: "Seguidores",
  "Friends who follow each other": "Amigos que se siguen mutuamente",
  Home: "Inicio",
  Incomplete: "Incompleto",
  Language: "Idioma",
  Light: "Claro",
  "Loading Meltiply…": "Cargando Meltiply…",
  "Loading posts…": "Cargando publicaciones…",
  "Meltiply could not reach the API. Check your connection and try again.":
    "Meltiply no pudo conectar con la API. Revisa tu conexión e inténtalo de nuevo.",
  "Meltiply could not refresh this view": "Meltiply no pudo actualizar esta vista",
  "Meltiply is temporarily unavailable": "Meltiply no está disponible temporalmente",
  Name: "Nombre",
  "Next 7 days": "Próximos 7 días",
  "Only you": "Solo tú",
  Platform: "Plataforma",
  "Prepare assets, schedule distribution, monitor provider state, and respond to your audience from one dependable workspace.":
    "Prepara recursos, programa la distribución, supervisa el estado del proveedor y responde a tu audiencia desde un espacio de trabajo fiable.",
  Publishing: "Publicación",
  "Publishing calendar": "Calendario de publicaciones",
  Ready: "Listo",
  Reconnect: "Volver a conectar",
  "Reload workspace": "Recargar espacio de trabajo",
  Reschedule: "Reprogramar",
  "Retrying…": "Reintentando…",
  "Return to overview": "Volver al resumen",
  Schedule: "Programar",
  Scheduled: "Programado",
  Settings: "Configuración",
  "Sign in": "Iniciar sesión",
  "Sign in again": "Volver a iniciar sesión",
  "Sign in again to continue.": "Vuelve a iniciar sesión para continuar.",
  Status: "Estado",
  Stitch: "Stitch",
  "The platform could not be disconnected": "No se pudo desconectar la plataforma",
  "The request can be retried.": "La solicitud se puede reintentar.",
  Theme: "Tema",
  "This asset cannot be deleted while it is in use.":
    "Este recurso no se puede eliminar mientras está en uso.",
  "This changed while you were working. Refresh and try again.":
    "Esto cambió mientras trabajabas. Actualiza e inténtalo de nuevo.",
  "Too many requests. Wait a moment and try again.":
    "Demasiadas solicitudes. Espera un momento e inténtalo de nuevo.",
  "Try again": "Intentar de nuevo",
  Unavailable: "No disponible",
  "Upload failed. Retry or remove this attachment.":
    "La carga falló. Reintenta o elimina este archivo adjunto.",
  "Upload progress for {name}": "Progreso de carga de {name}",
  "Pause upload of {name}": "Pausar la carga de {name}",
  "Resume upload of {name}": "Reanudar la carga de {name}",
  "Cancel upload of {name}": "Cancelar la carga de {name}",
  "Retry upload of {name}": "Reintentar la carga de {name}",
  "This attachment could not be processed.": "No se pudo procesar este archivo adjunto.",
  "Drag images or videos here, or use Add Media. Attachments keep their order.":
    "Arrastra imágenes o vídeos aquí o usa Añadir medios. Los archivos adjuntos mantienen su orden.",
  "Move attachment {index} earlier": "Mover el archivo adjunto {index} antes",
  "Move attachment {index} later": "Mover el archivo adjunto {index} después",
  "Replace attachment {index}": "Reemplazar el archivo adjunto {index}",
  "Remove attachment {index}": "Eliminar el archivo adjunto {index}",
  "Attachments for {name}": "Archivos adjuntos para {name}",
  "Use post attachments": "Usar adjuntos de la publicación",
  "All post attachments": "Todos los adjuntos de la publicación",
  "Selected attachments": "Adjuntos seleccionados",
  "Text only": "Solo texto",
  "Saved to your workspace at {time}": "Guardado en tu espacio de trabajo a las {time}",
  "Unsaved changes are kept in this browser until you save.":
    "Los cambios sin guardar se conservan en este navegador hasta que los guardes.",
  "Draft changes are saved to your workspace when you save.":
    "Los cambios del borrador se guardan en tu espacio de trabajo cuando los guardes.",
  Draft: "Borrador",
  Now: "Ahora",
  "Saves this post's text, attachments, and channel settings without publishing":
    "Guarda el texto, los archivos adjuntos y la configuración de canales de esta publicación sin publicar",
  "Your post text, attachments, and channel settings are stored.":
    "El texto, los archivos adjuntos y la configuración de canales de tu publicación están guardados.",
  "Select a Brand Profile before uploading media.":
    "Selecciona un perfil de marca antes de subir medios.",
  "Wait for {count} attachment(s) to finish starting their upload, or remove them.":
    "Espera a que {count} archivo(s) adjunto(s) terminen de iniciar su carga o elimínalos.",
  "{name}: accepts at most {limit} attachment(s) per post.":
    "{name}: admite como máximo {limit} archivo(s) adjunto(s) por publicación.",
  "{name}: cannot combine these attachments; a multi-attachment post accepts {types} media only.":
    "{name}: no puede combinar estos archivos adjuntos; una publicación con varios archivos adjuntos solo admite medios {types}.",
  "{name}: cannot publish more than one attachment per post.":
    "{name}: no puede publicar más de un archivo adjunto por publicación.",
  "{name}: requires at least {limit} attachment(s) per post.":
    "{name}: requiere al menos {limit} archivo(s) adjunto(s) por publicación.",
  "{name}: attachment {file} is not usable — {reason}":
    "{name}: el archivo adjunto {file} no se puede usar: {reason}",
  "{name}: wait for attachment {file} to finish processing before publishing.":
    "{name}: espera a que el archivo adjunto {file} termine de procesarse antes de publicar.",
  "Platform publishing limits are still loading; try again in a moment.":
    "Los límites de publicación de la plataforma aún se están cargando; inténtalo de nuevo en un momento.",
  "View details": "Ver detalles",
  "We could not complete that request. Try again in a moment.":
    "No pudimos completar la solicitud. Inténtalo de nuevo en un momento.",
  "We could not refresh this view. Try again in a moment.":
    "No pudimos actualizar esta vista. Inténtalo de nuevo en un momento.",
  "Week {week}": "Semana {week}",
  Workspace: "Espacio de trabajo",
  Range: "Intervalo",
  "You are offline": "No tienes conexión",
  "Your session expired": "Tu sesión ha caducado",
  "Your session no longer has access to this workspace.":
    "Tu sesión ya no tiene acceso a este espacio de trabajo.",
  "Your storage or upload quota has been reached.":
    "Has alcanzado tu cuota de almacenamiento o cargas.",
  "An error has occurred.": "Se ha producido un error.",
  comments: "comentarios",
  Connection: "Conexión",
  "Connection status": "Estado de la conexión",
  "Disconnect {platform}?": "¿Desconectar {platform}?",
  Dismiss: "Descartar",
  Month: "Mes",
  Posts: "Publicaciones",
  "Saving…": "Guardando…",
  "This Channel publishes its own caption for the post.":
    "Este canal publica su propio texto para la publicación.",
  Today: "Hoy",
  Week: "Semana",
  "Changes are paused until your connection returns.":
    "Los cambios están pausados hasta que vuelva tu conexión.",
  "Meltiply authentication provider is unavailable.":
    "El proveedor de autenticación de Meltiply no está disponible.",
  "That item is no longer available.": "Ese elemento ya no está disponible.",
  image: "imagen",
  video: "vídeo",
  text: "texto",
  views: "visualizaciones",
  likes: "me gusta",
  shares: "compartidos",
  "{name} does not accept {type} assets.": "{name} no acepta recursos de {type}.",
  "{name} does not accept this asset's media type.":
    "{name} no acepta el tipo multimedia de este recurso.",
  "{name} publishing is not available for this account.":
    "La publicación en {name} no está disponible para esta cuenta.",
  "Reconnect {name} before publishing.": "Vuelve a conectar {name} antes de publicar.",
  "This asset exceeds the {name} file-size limit.":
    "Este recurso supera el límite de tamaño de archivo de {name}.",
  "This asset exceeds the {name} video-duration limit.":
    "Este recurso supera el límite de duración de vídeo de {name}.",
  "{platform} connected successfully.": "{platform} se conectó correctamente.",
  "{platform} authorization succeeded, but the account could not be saved. Try connecting again.":
    "La autorización de {platform} se completó, pero no se pudo guardar la cuenta. Intenta conectarla de nuevo.",
  "{platform} connection was cancelled before permission was granted.":
    "La conexión de {platform} se canceló antes de conceder el permiso.",
  "{platform} connection could not be completed because the provider omitted its code.":
    "La conexión de {platform} no se pudo completar porque el proveedor omitió su código.",
  "{platform} connection could not be completed because the provider rejected the exchange.":
    "La conexión de {platform} no se pudo completar porque el proveedor rechazó el intercambio.",
  "{platform} authorization did not identify a single publishing account. Choose the intended account in the provider and try again.":
    "La autorización de {platform} no identificó una única cuenta de publicación. Elige la cuenta deseada en el proveedor e inténtalo de nuevo.",
  "{platform} connection is not available yet.":
    "La conexión de {platform} todavía no está disponible.",
  "{platform} connection could not be started. Share the request ID with support if the problem continues.":
    "No se pudo iniciar la conexión de {platform}. Comparte el ID de solicitud con soporte si el problema continúa.",
  "{platform} connection could not reach the API. Check your connection and try again.":
    "La conexión de {platform} no pudo acceder a la API. Comprueba tu conexión e inténtalo de nuevo.",
  "{platform} connection expired or could not be verified. Start again when the provider is available.":
    "La conexión de {platform} caducó o no se pudo verificar. Empieza de nuevo cuando el proveedor esté disponible.",
  "{platform} connection was rejected because the provider is unknown.":
    "La conexión de {platform} se rechazó porque el proveedor es desconocido.",
  "(ungrouped)": "(sin agrupar)",
  "AI Generated": "Generado por IA",
  Actions: "Acciones",
  Active: "Activo",
  "Add account": "Añadir cuenta",
  "Add Another": "Añadir otro",
  "Add Channel": "Añadir canal",
  "Add Media": "Añadir medios",
  "Add or connect a new social channel": "Añadir o conectar un nuevo canal social",
  "All dates": "Todas las fechas",
  "All statuses": "Todos los estados",
  Apply: "Aplicar",
  "Attached Media ({count})": "Medios adjuntos ({count})",
  "Brand Content": "Contenido de marca",
  "Brand Profile": "Perfil de marca",
  "Post status": "Estado de publicación",
  "Brand Profiles": "Perfiles de marca",
  "{count} of {total} ordered": "{count} de {total} en orden",
  "{count} ordered": "{count} en orden",
  "{count} ordered attachment(s)": "{count} archivo(s) adjunto(s) en orden",
  "Cancel all pending": "Cancelar todos los pendientes",
  "Cancel pending channels?": "¿Cancelar los canales pendientes?",
  "Cancel channels": "Cancelar canales",
  "Deleting this post removes its draft and stops its pending channels. Anything already published stays live on its platform — deleting a post here never removes a copy from a platform.":
    "Al eliminar esta publicación se borra su borrador y se detienen sus canales pendientes. Lo ya publicado sigue visible en su plataforma: eliminar una publicación aquí nunca elimina una copia de la plataforma.",
  Cancelled: "Cancelado",
  Channel: "Canal",
  Attachments: "Archivos adjuntos",
  "Channel disconnected": "Canal desconectado",
  "Channel is unavailable": "El canal no está disponible",
  "Clear filters": "Limpiar filtros",
  "Clear search": "Limpiar búsqueda",
  "Connect a channel": "Conectar un canal",
  "Post content": "Contenido de la publicación",
  "What do you want to publish?": "¿Qué quieres publicar?",
  "Connect social account": "Conectar cuenta social",
  "Connect your social accounts to start publishing and scheduling across platforms.":
    "Conecta tus cuentas sociales para empezar a publicar y programar en todas las plataformas.",
  "Could not cancel this post": "No se pudo cancelar esta publicación",
  "Could not delete this post": "No se pudo eliminar esta publicación",
  "Could not load post": "No se pudo cargar la publicación",
  "Could not reschedule this post": "No se pudo reprogramar esta publicación",
  "Could not retry this post": "No se pudo reintentar esta publicación",
  "Create post": "Crear publicación",
  "Custom Text for {name}": "Texto personalizado para {name}",
  "Decrease grid columns": "Reducir columnas de cuadrícula",
  "Delete draft": "Eliminar borrador",
  "Delete this post?": "¿Eliminar esta publicación?",
  "Delete post": "Eliminar publicación",
  Destinations: "Destinos",
  "Disconnecting…": "Desconectando…",
  "Distribution to {count} channel(s) has been queued.":
    "La distribución a {count} canal(es) ha sido puesta en cola.",
  "Distribution to {count} channel(s) is scheduled.":
    "La distribución a {count} canal(es) está programada.",
  "Draft saved": "Borrador guardado",
  Drafts: "Borradores",
  Edit: "Editar",
  "Edit post": "Editar publicación",
  "Editing published posts is not supported yet":
    "Aún no se admite editar publicaciones publicadas",
  "Enter YouTube title...": "Introduce el título de YouTube...",
  Facebook: "Facebook",
  Failed: "Fallido",
  "Friends Only": "Solo amigos",
  Grid: "Cuadrícula",
  "Increase grid columns": "Aumentar columnas de cuadrícula",
  Instagram: "Instagram",
  "Keep post": "Conservar publicación",
  "Meltiply Workspace": "Espacio de trabajo de Meltiply",
  "No accounts match the active filters.": "Ninguna cuenta coincide con los filtros activos.",
  "No caption": "Sin pie de foto",
  "No channels connected yet": "Aún no hay canales conectados",
  "No platforms match “{query}”.": "Ninguna plataforma coincide con “{query}”.",
  "No posts found matching the active filters.":
    "No se encontraron publicaciones que coincidan con los filtros activos.",
  "No posts match filters": "Ninguna publicación coincide con los filtros",
  "No posts scheduled for this day yet. Click below to schedule one.":
    "Aún no hay publicaciones programadas para este día. Haz clic a continuación para programar una.",
  "No social channels connected for this profile.":
    "No hay canales sociales conectados para este perfil.",
  Offline: "Desconectado",
  "Only drafts and scheduled posts can be edited.":
    "Solo se pueden editar borradores y publicaciones programadas.",
  "Open navigation menu": "Abrir menú de navegación",
  "Organic Brand": "Marca orgánica",
  "Past 30 days": "Últimos 30 días",
  Paused: "Pausado",
  "Pending distributions for this post will be cancelled. Already-published channels are unaffected.":
    "Las distribuciones pendientes para esta publicación serán canceladas. Los canales ya publicados no se verán afectados.",
  "Please fix the following before submitting:": "Corrige lo siguiente antes de enviar:",
  "Please provide a valid schedule date and time.":
    "Proporciona una fecha y hora de programación válidas.",
  "Please select at least one destination channel.": "Selecciona al menos un canal de destino.",
  "Post Title (optional, max 90 characters)":
    "Título de publicación (opcional, máx. 90 caracteres)",
  "Post details": "Detalles de la publicación",
  "Post must contain text content or at least one media item.":
    "La publicación debe contener texto o al menos un archivo multimedia.",
  "Post published": "Publicación publicada",
  "Post scheduled": "Publicación programada",
  "Posts for": "Publicaciones para",
  Preparing: "Preparando",
  "Privacy Level": "Nivel de privacidad",
  "Private (Self Only)": "Privado (solo yo)",
  Processing: "Procesando",
  "Public to Everyone": "Público para todos",
  "Publish Now": "Publicar ahora",
  Published: "Publicado",
  Queued: "En cola",
  "Re-authenticate": "Volver a autenticar",
  "Redirecting…": "Redirigiendo…",
  "Remove Custom Override": "Eliminar personalización",
  "Save Draft": "Guardar borrador",
  Save: "Guardar",
  "Post deleted": "Publicación eliminada",
  "Schedule post for this date": "Programar publicación para esta fecha",
  "Scheduled and queued posts for this channel will stop publishing. You can reconnect it at any time.":
    "Las publicaciones programadas y en cola para este canal dejarán de publicarse. Puedes reconectarlo en cualquier momento.",
  "Scheduled post cancelled": "Publicación programada cancelada",
  "Saved destination — not scheduled yet. Scheduling or removing this Channel leaves every other Channel's result unchanged.":
    "Destino guardado, aún sin programar. Programar o quitar este canal no cambia el resultado de ningún otro canal.",
  "Search accounts": "Buscar cuentas",
  "Search accounts…": "Buscar cuentas…",
  "Search platforms…": "Buscar plataformas…",
  "Search posts...": "Buscar publicaciones...",
  "Select privacy": "Seleccionar privacidad",
  "Shared Content": "Contenido compartido",
  "Social Channels": "Canales sociales",
  "Submission Error": "Error de envío",
  "Tags (comma separated, max 500 chars combined)":
    "Etiquetas (separadas por comas, máx. 500 caracteres combinados)",
  "Targeting {count} channel(s)": "Destinado a {count} canal(es)",
  "Choose a Brand Profile to compose, schedule, or publish.":
    "Elige un perfil de marca para redactar, programar o publicar.",
  "Choose a Brand Profile": "Elige un perfil de marca",
  "Choose a Brand Profile to pick publish destinations.":
    "Elige un perfil de marca para elegir destinos de publicación.",
  "Queues this post to {count} channel(s) at the selected time.":
    "Pone esta publicación en cola para {count} canal(es) a la hora seleccionada.",
  "Queues this post to {count} channel(s) right away.":
    "Pone esta publicación en cola para {count} canal(es) ahora mismo.",
  Threads: "Threads",
  "TikTok post title...": "Título de publicación de TikTok...",
  "Time: Newest first": "Fecha: Más recientes primero",
  "Time: Oldest first": "Fecha: Más antiguos primero",
  "Try adjusting your search query, status, or date range filters.":
    "Prueba a ajustar la búsqueda, el estado o los filtros de fecha.",
  "Untitled post": "Publicación sin título",
  "Upload failed": "Error al subir",
  Uploading: "Subiendo",
  "Uses standard text and attached media.": "Usa texto estándar y medios adjuntos.",
  "Video Title (required, 2-100 characters)": "Título del vídeo (obligatorio, 2-100 caracteres)",
  "View on {platform}": "Ver en {platform}",
  "What do you want to publish? Share across all selected destinations...":
    "¿Qué deseas publicar? Comparte en todos los destinos seleccionados...",
  YouTube: "YouTube",
  completed: "completado",
  connected: "conectado",
  media: "medios",
  reach: "alcance",
  "tech, tutorial, social media": "tecnología, tutorial, redes sociales",
  "{count} channel(s)": "{count} canal(es)",
  "{count} channel(s) · {date}": "{count} canal(es) · {date}",
  "Character limit unavailable": "Límite de caracteres no disponible",
  "{count}/{limit} characters": "{count}/{limit} caracteres",
  "{count} platforms": "{count} plataformas",
  "{count} post(s) scheduled or published on this date.":
    "{count} publicación(es) programada(s) o publicada(s) en esta fecha.",
  "{name} Configuration": "Configuración de {name}",
  "{name}: YouTube requires a video title between 2 and 100 characters.":
    "{name}: YouTube requiere un título de vídeo de entre 2 y 100 caracteres.",
  "{name}: YouTube tags cannot exceed 500 characters combined.":
    "{name}: las etiquetas de YouTube no pueden superar los 500 caracteres combinados.",
  "{name}: choose a TikTok privacy level.": "{name}: elige un nivel de privacidad de TikTok.",
  "{name}: comments are not allowed for this creator.":
    "{name}: los comentarios no están permitidos para este creador.",
  "{name}: duet is not allowed for this creator.":
    "{name}: los duetos no están permitidos para este creador.",
  "{name}: post text is empty for this channel.":
    "{name}: el texto de la publicación está vacío para este canal.",
  "{name}: stitch is not allowed for this creator.":
    "{name}: stitch no está permitido para este creador.",
  "{name}: text exceeds the {limit}-character limit for this platform.":
    "{name}: el texto supera el límite de {limit} caracteres para esta plataforma.",
  "{name}: the selected privacy level is not available for this creator.":
    "{name}: el nivel de privacidad seleccionado no está disponible para este creador.",
  "{name}: this channel does not accept {type} media.":
    "{name}: este canal no admite medios de tipo {type}.",
  "{name}: use no more than {limit} tags.": "{name}: no uses más de {limit} etiquetas.",
  Disabled: "Desactivado",
  "No platform": "Sin plataforma",
  Post: "Publicación",
  "Post rescheduled": "Publicación reprogramada",
  Retry: "Reintentar",
  "Retry queued": "Reintento en cola",
  "Sign out": "Cerrar sesión",
  "This post's state could not be confirmed with the platform. It may need manual review.":
    "El estado de esta publicación no se pudo confirmar con la plataforma. Puede requerir revisión manual.",
  "Unassigned channel": "Canal sin asignar",
  "#viral #shorts": "#viral #shorts",
  "All Brand Profiles": "Todos los perfiles de marca",
  "Ask a workspace admin to create a Brand Profile.":
    "Pide a un administrador del espacio de trabajo que cree un perfil de marca.",
  "Choose a profile color": "Elige un color de perfil",
  "Create Brand Profile": "Crear perfil de marca",
  "Create a Brand Profile before connecting accounts.":
    "Crea un perfil de marca antes de conectar cuentas.",
  "Create profile": "Crear perfil",
  "Delete Brand Profile": "Eliminar perfil de marca",
  "Delete profile": "Eliminar perfil",
  "Deleting this Brand Profile cancels its scheduled posts, disconnects its channels, and blocks new work. The profile is purged permanently after 7 days; you can restore it until then.":
    "Eliminar este perfil de marca cancela sus publicaciones programadas, desconecta sus canales y bloquea el trabajo nuevo. El perfil se purga de forma permanente tras 7 días; puedes restaurarlo hasta entonces.",
  "Edit profile": "Editar perfil",
  "Profile name": "Nombre del perfil",
  "Update Brand Profile": "Actualizar perfil de marca",
  "Update profile": "Actualizar perfil",
  "Select a Brand Profile": "Seleccionar un perfil de marca",
  "Select a Brand Profile before publishing.": "Selecciona un perfil de marca antes de publicar.",
  "Something went wrong": "Algo salió mal",
  "This post belongs to {name}. Switch to that Brand Profile to edit it.":
    "Esta publicación pertenece a {name}. Cambia a ese perfil de marca para editarla.",
  "Unknown profile": "Perfil desconocido",
  "another Brand Profile": "otro perfil de marca",
  "e.g. Acme Corp": "p. ej. Acme Corp",
  "Select Facebook Page": "Seleccionar página de Facebook",
  "Choose the Facebook Page you want to connect to your Brand Profile.":
    "Elige la página de Facebook que quieres conectar a tu perfil de marca.",
  "Connecting to:": "Conectando a:",
  "Loading eligible Facebook Pages…": "Cargando páginas de Facebook aptas…",
  "Unable to load Facebook Pages": "No se pudieron cargar las páginas de Facebook",
  "The selection ticket has expired or could not be found.":
    "El ticket de selección ha caducado o no se pudo encontrar.",
  "No eligible Facebook Pages found": "No se encontraron páginas de Facebook aptas",
  "You need admin or publishing access on at least one Facebook Page to connect it. Create or request access to a Page in Facebook, then try connecting again.":
    "Necesitas acceso de administrador o permisos de publicación en al menos una página de Facebook para conectarla. Crea o solicita acceso a una página en Facebook y vuelve a intentarlo.",
  "Eligible Facebook Pages": "Páginas de Facebook aptas",
  "Unnamed Page": "Página sin nombre",
  "The selected Page could not be connected.": "No se pudo conectar la página seleccionada.",
  "Connect Page": "Conectar página",
  "Connecting…": "Conectando…",
  Permissions: "Permisos",
  "No permissions granted": "Sin permisos otorgados",
  "ID: {id}": "ID: {id}",
  "Facebook connected successfully.": "Facebook se conectó correctamente.",
};

const statusTranslations: Record<Language, Record<string, string>> = {
  en: {
    awaiting_provider: "Awaiting provider",
    cancelled: "Cancelled",
    cancel_requested: "Cancellation requested",
    deleted: "Deleted",
    deleting: "Deleting",
    draft: "Draft",
    failed: "Failed",
    needs_reconciliation: "Needs reconciliation",
    pending_upload: "Pending upload",
    processing: "Processing",
    published: "Published",
    queued: "Queued",
    ready: "Ready",
    replied: "Replied",
    scheduled: "Scheduled",
    sent: "Sent",
    uploading: "Uploading",
    active: "Active",
    admin: "Admin",
    connected: "Connected",
    expired: "Expired",
    expiring: "Expiring",
    follower_of_creator: "Followers",
    member: "Member",
    mutual_follow_friends: "Friends who follow each other",
    not_replied: "Not replied",
    owner: "Owner",
    public_to_everyone: "Everyone",
    reconnect_required: "Reconnect required",
    revoked: "Revoked",
    self_only: "Only you",
  },
  es: {
    awaiting_provider: "Esperando al proveedor",
    cancelled: "Cancelada",
    cancel_requested: "Cancelación solicitada",
    deleted: "Eliminado",
    deleting: "Eliminando",
    draft: "Borrador",
    failed: "Fallido",
    needs_reconciliation: "Requiere conciliación",
    pending_upload: "Carga pendiente",
    processing: "Procesando",
    published: "Publicado",
    queued: "En cola",
    ready: "Listo",
    replied: "Respondido",
    scheduled: "Programado",
    sent: "Enviado",
    uploading: "Cargando",
    active: "Activo",
    admin: "Administrador",
    connected: "Conectada",
    expired: "Caducada",
    expiring: "Próxima a caducar",
    follower_of_creator: "Seguidores",
    member: "Miembro",
    mutual_follow_friends: "Amigos que se siguen mutuamente",
    not_replied: "Sin responder",
    owner: "Propietario",
    public_to_everyone: "Todos",
    reconnect_required: "Requiere reconexión",
    revoked: "Revocada",
    self_only: "Solo tú",
  },
};

/**
 * Substitutes named placeholder tokens (e.g. `{name}`) in a message string with provided values.
 *
 * @param message Template string containing `{token}` placeholders.
 * @param values Dictionary mapping token names to string or number substitutions.
 * @returns Interpolated string with replaced variables.
 */
function interpolate(message: string, values?: TranslationValues): string {
  if (!values) return message;
  return message.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : match,
  );
}

/** Resolves a message's text in the active language, before any substitution. */
function lookupMessage(language: Language, message: string): string {
  return language === "es" ? (spanishTranslations[message] ?? message) : message;
}

/**
 * Substitutes named placeholder tokens (e.g. `{count}`) in a translated message
 * with nodes, so a sentence can hold a component — a count that rolls, for
 * instance — without the surrounding copy being assembled from fragments.
 *
 * Literal text keeps the same dev-only pseudo-localization as `translate`; the
 * inserted nodes are left alone, because their own content is the shipped surface.
 * A token with no value keeps its placeholder text, exactly as `interpolate` does.
 *
 * @param language Active language code ("en" or "es").
 * @param message English source message key.
 * @param values Nodes keyed by the placeholder tokens they replace.
 * @returns The message as nodes, ready to render inside a sentence.
 */
function translateNodes(
  language: Language,
  message: string,
  values: Record<string, ReactNode>,
): ReactNode {
  const parts: ReactNode[] = [];
  const template = lookupMessage(language, message);
  let cursor = 0;
  for (const match of template.matchAll(/\{(\w+)\}/g)) {
    const start = match.index ?? 0;
    if (start > cursor) parts.push(template.slice(cursor, start));
    parts.push(
      <Fragment key={`${match[1]}-${start}`}>
        {Object.hasOwn(values, match[1]) ? values[match[1]] : match[0]}
      </Fragment>,
    );
    cursor = start + match[0].length;
  }
  if (cursor < template.length) parts.push(template.slice(cursor));

  if (!isDevMode() || !isPseudoLocalized()) return parts;
  return parts.map((part) => (typeof part === "string" ? pseudoLocalize(part) : part));
}

/**
 * Translates an English UI string into the active target language with variable interpolation.
 * Falls back to the raw message when a Spanish translation entry is absent.
 * In development builds the DevBox pseudo-localization toggle additionally
 * expands every returned string (~35% growth + accents) so layout resilience
 * can be verified in place; the branch is stripped from production bundles.
 *
 * @param language Active language code ("en" or "es").
 * @param message English source message key.
 * @param values Optional substitution values for placeholders in the template.
 * @returns Translated, interpolated text.
 */
export function translate(language: Language, message: string, values?: TranslationValues): string {
  const translated = interpolate(lookupMessage(language, message), values);
  return isDevMode() && isPseudoLocalized() ? pseudoLocalize(translated) : translated;
}

/**
 * Translates an internal enum or status identifier (e.g. `awaiting_provider`) into a localized label.
 * Replaces underscores with spaces as a fallback if no explicit translation exists.
 * Subject to the same dev-only pseudo-localization expansion as `translate`.
 *
 * @param language Target language code ("en" or "es").
 * @param status Status identifier string.
 * @returns Localized status label.
 */
function translateStatus(language: Language, status: string): string {
  const label = statusTranslations[language][status] ?? status.replaceAll("_", " ");
  return isDevMode() && isPseudoLocalized() ? pseudoLocalize(label) : label;
}

/**
 * Reads the user's language preference only after functional consent, falling
 * back to `"en"` when it is absent, invalid, or unavailable.
 *
 * @returns Active `Language` code ("en" or "es").
 */
function readStoredLanguage(): Language {
  const stored = readFunctionalStorage(languageStorageKey);
  return supportedLanguages.some(({ code }) => code === stored) ? (stored as Language) : "en";
}

type I18nContextValue = {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (message: string, values?: TranslationValues) => string;
  tStatus: (status: string) => string;
};

const defaultValue: I18nContextValue = {
  language: "en",
  setLanguage: () => undefined,
  t: (message, values) => translate("en", message, values),
  tStatus: (status) => translateStatus("en", status),
};

const I18nContext = createContext<I18nContextValue>(defaultValue);

type I18nProviderProps = {
  children: React.ReactNode;
};

/**
 * Synchronizes the `lang` attribute and meta description on
 * `document.documentElement`, and persists language selection only after
 * functional consent. The current page language remains usable in memory when
 * optional storage is denied.
 *
 * @param props Component props with children.
 * @returns Context provider element.
 */
export function I18nProvider({ children }: I18nProviderProps): React.ReactElement {
  const [language, setLanguageState] = useState<Language>(readStoredLanguage);
  // Re-render when the DevBox pseudo-localization flag flips so every `t()`
  // and `translate()` consumer re-reads transformed strings. The tick must
  // feed the memoized context value below — a stable value identity would let
  // React bail out of consumer re-renders entirely.
  const [pseudoTick, setPseudoTick] = useState(0);

  /** Changes the in-memory language immediately and persists it only with functional consent. */
  const setLanguage = useCallback((nextLanguage: Language) => {
    setLanguageState(nextLanguage);
    writeFunctionalStorage(languageStorageKey, nextLanguage);
  }, []);

  useLayoutEffect(() => {
    // Dev-only listener: the event name is a constant, but the subscription
    // itself is stripped from production bundles with the DevBox.
    if (!isDevMode()) return;
    const onPseudoToggle = () => setPseudoTick((tick) => tick + 1);
    window.addEventListener(pseudoLocaleEvent, onPseudoToggle);
    return () => window.removeEventListener(pseudoLocaleEvent, onPseudoToggle);
  }, []);

  useLayoutEffect(() => {
    document.documentElement.lang = language;
    const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (description) {
      description.content = translate(
        language,
        "Prepare assets, schedule distribution, monitor provider state, and respond to your audience from one dependable workspace.",
      );
    }
  }, [language]);
  // Rebuilt whenever language or pseudoTick changes; pseudoTick exists so the
  // dev-only pseudo-localization toggle re-renders consumers with expanded
  // strings. Memoizing keeps that key complete while a provider re-render for
  // any other reason - consent, an unmounting sibling, a dev toggle - from
  // handing every `t()`/`translate()` consumer a new context identity.
  const value = useMemo<I18nContextValue>(() => {
    void pseudoTick;
    return {
      language,
      setLanguage,
      t: (message, values) => translate(language, message, values),
      tStatus: (status) => translateStatus(language, status),
    };
  }, [language, setLanguage, pseudoTick]);

  return <I18nContext value={value}>{children}</I18nContext>;
}

/**
 * Accesses internationalization state and translation helpers (`t`, `tStatus`) from `I18nContext`.
 *
 * @returns `I18nContextValue` object containing language state and translation functions.
 */
export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}

/**
 * A translated message whose placeholders carry components, so a sentence can hold
 * a surface — a count that rolls, for instance — instead of being assembled from
 * translated fragments. Reads the active language from `I18nContext` and renders
 * `translateNodes`, so a message resolves exactly as `t` resolves it.
 *
 * @param props.message - English source message key containing `{token}` placeholders.
 * @param props.values - Nodes keyed by the placeholder tokens they replace.
 * @returns The translated sentence, ready to render where the copy belongs.
 */
export function Trans({
  message,
  values,
}: {
  message: string;
  values: Record<string, ReactNode>;
}): React.ReactElement {
  const { language } = useI18n();
  return <>{translateNodes(language, message, values)}</>;
}
