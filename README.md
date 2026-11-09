# manuortega91

Tarea automática del Observatorio 29N. Revisa tres veces al día los sondeos publicados en elecciones29n.com y guarda en `data/sondeos.json` una copia cifrada que solo puede leer el Observatorio.

El repositorio contiene únicamente la clave pública de cifrado. Si el formato cambia o aparecen valores imposibles, la tarea falla y se conserva el último archivo bueno. Si la web de origen bloquea sus sondeos, y del 24 de noviembre al 29 de noviembre a las 20:00 (hora de Madrid) por el artículo 69.7 de la LOREG, el archivo queda vacío.
